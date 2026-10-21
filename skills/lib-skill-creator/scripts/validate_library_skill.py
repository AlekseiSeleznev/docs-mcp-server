#!/usr/bin/env python3
"""Validate the shared and profile-specific contract of a lib-* skill."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit


def validate(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    skill_file = skill_dir / "SKILL.md"
    agent_file = skill_dir / "agents" / "openai.yaml"
    if not skill_file.is_file():
        return ["SKILL.md not found"]
    if not agent_file.is_file():
        return ["agents/openai.yaml not found"]

    text = skill_file.read_text(encoding="utf-8")
    agent = agent_file.read_text(encoding="utf-8")
    if not re.search(r"^name:\s*lib-[a-z0-9-]+\s*$", text, re.MULTILINE):
        errors.append("frontmatter must contain a lib-* name")
    for required in ("lib-docs", "list_libraries", "[Источник]", "[Использованы библиотеки:"):
        if required not in text:
            errors.append(f"missing shared contract text: {required}")
    if 'value: "lib-docs"' not in agent:
        errors.append("openai.yaml must declare the lib-docs MCP dependency")

    guide = skill_dir / "references" / "indexed-pages.md"
    if "references/indexed-pages.md" not in text or not guide.is_file():
        errors.append("page-reading route must link a bundled indexed-pages.md")
    elif not all(word in guide.read_text() for word in ("list_pages", "read_page", "startChunk", "find_version")):
        errors.append("page-reading guide must cover navigation, continuation and versions")

    # A standalone skill must carry every locally linked reference.
    root = skill_dir.resolve()
    prose = re.sub(r"(?ms)^(`{3,}|~{3,})[^\n]*\n.*?^\1[ \t]*$", "", text)
    prose = re.sub(r"(`+).*?\1", "", prose, flags=re.DOTALL)
    for link in re.findall(r"\[[^\]]*\]\(([^)]+)\)", prose):
        href = link.strip().strip("<>")
        try:
            parsed = urlsplit(href)
        except ValueError:
            errors.append("invalid reference URL")
            continue
        if parsed.scheme or not parsed.path:
            continue
        relative = unquote(parsed.path)
        target = (root / relative).resolve()
        if not target.is_relative_to(root) or not target.is_file():
            errors.append(f"missing or external bundled reference: {relative}")

    version = re.search(r'^  version:\s*"(\d+\.\d+\.\d+)"\s*$', text, re.MULTILINE)
    if "references/skill-update.md" in text:
        if not version:
            errors.append("published updater requires metadata.version in X.Y.Z format")
        for relative in ("references/skill-update.md", "scripts/update-skill.py"):
            if not (root / relative).is_file():
                errors.append(f"missing updater resource: {relative}")

    # A completed release records exact bytes; client UI metadata remains local.
    record = root / "release.json"
    if record.exists():
        try:
            release = json.loads(record.read_text(encoding="utf-8"))
            name = re.search(r"^name:\s*(lib-[a-z0-9-]+)\s*$", text, re.MULTILINE)
            if not isinstance(release, dict) or not name or release.get("name") != name.group(1) or not version or release.get("version") != version.group(1):
                raise ValueError("release identity differs from skill")
            files = release.get("files")
            if not isinstance(files, dict) or "SKILL.md" not in files:
                raise ValueError("release inventory is missing")
            for relative, expected in files.items():
                target = root / relative
                if not target.resolve().is_relative_to(root) or not target.is_file():
                    errors.append(f"missing or external release file: {relative}")
                elif relative != "agents/openai.yaml" and hashlib.sha256(target.read_bytes()).hexdigest() != expected:
                    errors.append(f"release file changed: {relative}; rebuild with a new version")
        except (OSError, ValueError, TypeError):
            errors.append("release.json identity or inventory is invalid")

    artifact = "get_source_artifact" in text or "list_source_artifacts" in text
    catalog = (skill_dir / "references" / "libraries.yaml").is_file()
    if artifact:
        for required in (
            "list_source_artifacts",
            "get_source_artifact",
            "Matched Artifacts",
            "Related Artifacts",
            "save-source-artifacts.mjs",
            "SHA-256",
        ):
            if required not in text:
                errors.append(f"missing artifact invariant: {required}")
    else:
        if "limit=5" not in text and "limit: 5" not in text:
            errors.append("ordinary profiles must use limit 5")
        if "ровно один" not in text or "максимум" not in text.lower():
            errors.append("ordinary profiles must bound conditional refinement")
        if catalog and "references/libraries.yaml" not in text:
            errors.append("catalog-router must route through references/libraries.yaml")

    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: validate_library_skill.py PATH", file=sys.stderr)
        return 2
    errors = validate(Path(sys.argv[1]))
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("PASS: library skill profile contract is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
