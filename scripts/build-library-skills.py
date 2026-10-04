#!/usr/bin/env python3
"""Build standalone library skill packages and their public release catalog."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "skills"
PUBLIC = SKILLS / "md"
BASE_URL = "https://aichat.msgplaut.com/ai-library/"


def digest(data: bytes) -> str:
    """Compute the digest published for a release file or archive."""
    return hashlib.sha256(data).hexdigest()


def build() -> None:
    """Package exactly the skills listed by the site's installation selector."""
    html = (PUBLIC / "library-skills.html").read_text()
    names = sorted(set(re.findall(r'<option value="[^"<>]+/downloads/(lib-[a-z0-9-]+)\.zip"', html)))
    if not names:
        raise ValueError("the site has no library skills")
    releases = {}
    for name in names:
        directory = SKILLS / name
        text = (directory / "SKILL.md").read_text()
        version = re.search(r'^  version: "(\d+\.\d+\.\d+)"$', text, re.MULTILINE)
        if not version:
            raise ValueError(f"missing release version: {name}")
        (directory / "scripts").mkdir(exist_ok=True)
        (directory / "references").mkdir(exist_ok=True)
        shutil.copyfile(ROOT / "scripts/update-library-skill.py", directory / "scripts/update-skill.py")
        shutil.copyfile(SKILLS / "lib-skill-creator/references/skill-update.md", directory / "references/skill-update.md")
        files = {
            path.relative_to(directory).as_posix(): path.read_bytes()
            for path in sorted(directory.rglob("*"))
            if path.is_file() and "__pycache__" not in path.parts and path.name != "release.json"
        }
        provenance = {"name": name, "version": version.group(1), "files": {path: digest(data) for path, data in files.items()}}
        release_file = directory / "release.json"
        release_file.write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + "\n")
        files["release.json"] = release_file.read_bytes()
        archive = PUBLIC / "downloads" / (name + ".zip")
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as package:
            for path, data in sorted(files.items()):
                item = zipfile.ZipInfo(name + "/" + path, (2026, 10, 4, 0, 0, 0))
                item.compress_type = zipfile.ZIP_DEFLATED
                item.external_attr = 0o644 << 16
                package.writestr(item, data)
        releases[name] = {
            "version": version.group(1), "url": BASE_URL + "downloads/" + name + ".zip",
            "sha256": digest(archive.read_bytes()), "files": {path: digest(data) for path, data in sorted(files.items())},
        }
    catalog = {"schemaVersion": 1, "skills": releases}
    (PUBLIC / "skill-versions.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"skills": len(releases), "catalog": "skills/md/skill-versions.json"}))


if __name__ == "__main__":
    build()
