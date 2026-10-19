"""Restore the verified pre-3.3.0 snapshot into a new volume and start the old image."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time


def run(args, **options):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, **options)


def digest(path):
    result = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("deployment_dir")
    parser.add_argument("release_dir")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    deployment = Path(args.deployment_dir).resolve()
    release = Path(args.release_dir).resolve()
    os.chdir(deployment)
    state = json.loads((release / "state.json").read_text())
    snapshot = release / "documents.before.db"
    if digest(snapshot) != state["backupSha256"]:
        raise RuntimeError("Snapshot integrity check failed")
    if digest(release / "compose.before.yml") != state["composeBeforeSha256"]:
        raise RuntimeError("Saved Compose integrity check failed")
    if digest(deployment / ".env.worker") != state["workerEnvironmentSha256"]:
        raise RuntimeError("Worker environment changed; preserve operator changes")
    expected = state.get("composeAfterSha256", state["composeBeforeSha256"])
    if digest(deployment / "docker-compose.yml") != expected:
        raise RuntimeError("Active Compose changed; preserve operator changes")
    run(["docker", "image", "inspect", state["previousImage"]])
    print(json.dumps({"rollbackReady": True, "apply": args.apply}), flush=True)
    if not args.apply:
        return
    roles = ["web", "mcp-read", "mcp-admin", "worker"]
    run(["docker", "compose", "stop", "-t", "60", *roles])
    volume = f"docs330-restored-{int(time.time())}"
    run(["docker", "volume", "create", volume])
    copy = "const fs=require('fs');fs.copyFileSync('/backup/documents.before.db','/data/documents.db');fs.chownSync('/data',1000,1000);fs.chownSync('/data/documents.db',1000,1000);fs.chmodSync('/data/documents.db',0o600);const crypto=require('crypto'),hash=crypto.createHash('sha256'),stream=fs.createReadStream('/data/documents.db');stream.on('data',b=>hash.update(b));stream.on('end',()=>{if(hash.digest('hex')!==process.argv[1])process.exitCode=1;});stream.on('error',()=>{process.exitCode=1;});"
    run(["docker", "run", "--rm", "--user", "0", "-v", f"{release}:/backup:ro", "-v", f"{volume}:/data", "--entrypoint", "node", state["previousImage"], "-e", copy, state["backupSha256"]])
    transform = "c.volumes??={};c.volumes['docs330-restored-data']={external:true,name:process.argv[1]};c.services.worker.volumes=c.services.worker.volumes.map(m=>typeof m==='string'&&m.split(':')[1]==='/data'?'docs330-restored-data:/data':typeof m==='object'&&m.target==='/data'?{...m,type:'volume',source:'docs330-restored-data'}:m);process.stdout.write(yaml.stringify(c));"
    script = "const fs=require('fs'),yaml=require('yaml');const c=yaml.parse(fs.readFileSync(0,'utf8'));" + transform
    restored = run(["docker", "run", "--rm", "-i", "--entrypoint", "node", state["previousImage"], "-e", script, volume], input=(release / "compose.before.yml").read_bytes())
    active = deployment / "docker-compose.yml"
    active.write_bytes(restored)
    run(["docker", "compose", "config", "--quiet"])
    run(["docker", "compose", "up", "-d"])
    state["restoredDataVolume"] = volume
    state["rollbackComposeSha256"] = digest(active)
    (release / "state.json").write_text(json.dumps(state, indent=2))
    print(json.dumps({"rollbackStarted": True, "originalDataVolumePreserved": True}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"rollbackFailed": True, "category": type(error).__name__}), flush=True)
        raise SystemExit(1) from None
