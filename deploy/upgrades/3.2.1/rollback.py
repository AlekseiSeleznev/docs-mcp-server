#!/usr/bin/env python3
"""Restore the verified previous image while retaining the additive database schema."""

import argparse
import hashlib
import json
import pathlib
import subprocess
import time


def digest(path):
    """Return the SHA256 of a small deployment configuration file."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(args):
    """Run a command without rendering deployment configuration or credentials."""
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("Deployment command failed; inspect the protected server logs")
    return result.stdout


def main():
    """Validate rollback evidence, then optionally restore the four application services."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("deployment", type=pathlib.Path)
    parser.add_argument("release", type=pathlib.Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    root, release = args.deployment.resolve(), args.release.resolve()
    state = json.loads((release / "state.json").read_text())
    current = root / "docker-compose.yml"
    previous = release / "compose.before.yml"
    if digest(previous) != state["composeSha256"]:
        raise RuntimeError("Previous Compose checksum differs from the saved baseline")
    if digest(root / ".env.worker") != state["workerEnvSha256"]:
        raise RuntimeError("Worker settings changed; review them before rollback")
    if digest(current) != state["deployedComposeSha256"]:
        raise RuntimeError("Deployment changed after this release; review it before rollback")
    run(["docker", "image", "inspect", state["oldImageReference"]])
    command = ["docker", "compose", "--project-directory", str(root), "-p",
               state["composeProject"], "-f", str(current)]
    services = ["worker", "mcp-read", "mcp-admin", "web"]
    if not args.apply:
        print(json.dumps({"rollbackReady": True, "mode": "image", "databaseRetained": True}))
        return
    deployed = current.read_bytes()

    def start_and_wait():
        run(command + ["config", "--quiet"])
        run(command + ["up", "-d", "--pull", "never", *services])
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            ids = run(command + ["ps", "-q", *services]).split()
            containers = json.loads(run(["docker", "inspect", *ids])) if ids else []
            if len(containers) == 4 and all(
                c["State"].get("Health", {}).get("Status") == "healthy" for c in containers
            ):
                return
            time.sleep(3)
        raise RuntimeError("Application services did not become healthy")

    try:
        run(command + ["stop", "-t", "30", *services])
        current.write_bytes(previous.read_bytes())
        start_and_wait()
    except Exception:
        current.write_bytes(deployed)
        start_and_wait()
        raise RuntimeError("Rollback failed; the deployment present before this command was restored") from None
    state["phase"] = "manual-image-rollback"
    (release / "state.json").write_text(json.dumps(state, indent=2))
    print(json.dumps({"imageRollback": "PASS", "databaseRetained": True,
                      "functionalAcceptanceRequired": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # No command output or configuration content reaches the terminal.
        print(json.dumps({"rollback": "FAILED", "errorType": type(error).__name__}))
        raise SystemExit(1) from None
