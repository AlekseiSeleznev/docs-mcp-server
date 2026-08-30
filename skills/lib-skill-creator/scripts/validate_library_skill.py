#!/usr/bin/env python3
"""Validate the shared and profile-specific contract of a lib-* skill."""

from __future__ import annotations

import re
import sys
from pathlib import Path


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
