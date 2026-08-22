#!/usr/bin/env python3
"""Validate the combining project-docs library skill."""

from __future__ import annotations

import re
import sys
from pathlib import Path

REQUIRED_TEXT = (
    "## Определить запрос",
    "## Выбрать библиотеки",
    "## Найти подтверждение",
    "## Скачать исходник",
    "## Сформировать ответ",
    "limit=5",
    "limit=10",
    "остаток бюджета `6 - |L|`",
    "не больше трёх поисков",
    "больше трёх библиотек",
    "остановись без вызова инструментов и footer",
    "Изоляция клиентов",
    "## По документации",
    "### 1.",
    "[Источник]",
    " | ",
    "## Выводы и рекомендации",
    "Snapshot date",
    "undefined",
    "сырые ответы MCP",
    "Даже при недоступности MCP",
    "[Использованы библиотеки: нет]",
    "references/library-map.md",
    "Не переводи запрос в английский",
    "xlsx-metadata",
    "unsupported-metadata",
    "artifacts/project-docs/<проект>/<nn-slug>/",
)


def validate(skill_dir: Path) -> list[str]:
    errors: list[str] = []
    skill_file = skill_dir / "SKILL.md"
    agent_file = skill_dir / "agents" / "openai.yaml"
    map_file = skill_dir / "references" / "library-map.md"
    writer = skill_dir / "scripts" / "save-source-artifacts.mjs"
    if not skill_file.is_file():
        return ["SKILL.md not found"]
    if not agent_file.is_file():
        errors.append("agents/openai.yaml not found")
    if not map_file.is_file():
        errors.append("references/library-map.md not found")
    if not writer.is_file():
        errors.append("scripts/save-source-artifacts.mjs not found")

    text = skill_file.read_text(encoding="utf-8")
    name_match = re.search(r"^name:\s*(lib-project-docs)\s*$", text, re.MULTILINE)
    if not name_match:
        errors.append("frontmatter must contain name lib-project-docs")
    for required in REQUIRED_TEXT:
        if required not in text:
            errors.append(f"missing contract text: {required}")

    if "литерал `[Источник]` используй ровно один раз" not in text:
        errors.append("missing one-source-marker rule")
    if "Никогда не повторяй `[Источник]` после `|`" not in text:
        errors.append("missing repeated source marker prohibition")
    if "каждый фрагмент по обе стороны разделителя" not in text:
        errors.append("missing complete multi-source tuple rule")
    if "не показывай `file://`" not in text:
        errors.append("missing internal file URL suppression rule")
    if "последней строкой без текста после неё" not in text.lower():
        errors.append("missing final-footer rule")
    if "без поясняющей фразы" not in text:
        errors.append("missing archive-only source rule")
    if "несовместим" not in text:
        errors.append("missing incompatible-version rule")
    if "?" in text:
        errors.append("concrete or example questions are forbidden in SKILL.md")
    if 'library="' in text:
        errors.append("combining skill must not pin library=\"...\"")

    if map_file.is_file():
        map_text = map_file.read_text(encoding="utf-8")
        libraries = re.findall(r"project-docs-(?:luve|mane|polis)-\d{2}-[a-z-]+", map_text)
        if len(libraries) != 22 or len(set(libraries)) != 22:
            errors.append("library map must contain exactly 22 unique technical names")
        if "Раздел 07 у Полюса отсутствует" not in map_text:
            errors.append("library map must record missing polis-07")

    if agent_file.is_file():
        agent_text = agent_file.read_text(encoding="utf-8")
        if 'value: "lib-docs"' not in agent_text:
            errors.append("openai.yaml must declare the lib-docs MCP dependency")
        if "allow_implicit_invocation: false" not in agent_text:
            errors.append("openai.yaml must disable implicit invocation")

    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: validate_project_docs_skill.py PATH", file=sys.stderr)
        return 2
    errors = validate(Path(sys.argv[1]))
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("PASS: project-docs combining skill contract is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
