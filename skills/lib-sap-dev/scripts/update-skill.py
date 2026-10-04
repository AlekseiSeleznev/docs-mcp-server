#!/usr/bin/env python3
"""Check and update one installed library skill using the published release catalog."""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from urllib.error import URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

CATALOG_URL = "https://aichat.msgplaut.com/ai-library/skill-versions.json"
MAX_BYTES = 4 * 1024 * 1024
TIMEOUT = 5


class InvalidRelease(ValueError):
    """A release cannot be verified against the catalog."""


class LocalChanges(ValueError):
    """Locally edited skill files need to be preserved."""


def version_tuple(value: str) -> tuple[int, int, int]:
    """Parse the stable semantic version used by the release catalog."""
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+", value):
        raise InvalidRelease("invalid version")
    return tuple(int(part) for part in value.split("."))


def skill_identity(data: bytes) -> tuple[str, str]:
    """Read skill name and optional release version from YAML frontmatter."""
    text = data.decode("utf-8")
    if not text.startswith("---\n"):
        raise InvalidRelease("missing frontmatter")
    frontmatter = text.split("\n---", 1)[0]
    name = re.search(r"^name: (lib-[a-z0-9-]+)\s*$", frontmatter, re.MULTILINE)
    version = re.search(r'^  version: ["\']?(\d+\.\d+\.\d+)["\']?\s*$', frontmatter, re.MULTILINE)
    if not name:
        raise InvalidRelease("invalid skill name")
    return name.group(1), version.group(1) if version else "0.0.0"


def safe_path(value: str) -> str:
    """Accept only normalized relative paths inside one skill."""
    if not isinstance(value, str) or "\\" in value:
        raise InvalidRelease("invalid path")
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in {".", ".."} for part in path.parts):
        raise InvalidRelease("invalid path")
    if path.as_posix() != value or ":" in value:
        raise InvalidRelease("invalid path")
    return value


def digest(data: bytes) -> str:
    """Compute the release content digest."""
    return hashlib.sha256(data).hexdigest()


class SameOriginRedirects(HTTPRedirectHandler):
    """Keep catalog and archive requests on the configured publication origin."""

    def __init__(self, catalog_url: str) -> None:
        super().__init__()
        self.base = urlparse(urljoin(catalog_url, "./"))

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urlparse(newurl)
        if (target.scheme, target.netloc) != (self.base.scheme, self.base.netloc) or not target.path.startswith(self.base.path):
            raise InvalidRelease("unexpected redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_bytes(url: str, catalog_url: str) -> bytes:
    """Download a bounded public response without credentials or persistent cache."""
    opener = build_opener(SameOriginRedirects(catalog_url))
    request = Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "Plaut-Library-Skill-Updater/1"})
    with opener.open(request, timeout=TIMEOUT) as response:
        data = response.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise InvalidRelease("response too large")
    return data


def verified_files(archive: bytes, name: str, release: dict) -> dict[str, bytes]:
    """Verify every archive member before changing any installed file."""
    if digest(archive) != release.get("sha256"):
        raise InvalidRelease("archive hash mismatch")
    hashes = release.get("files")
    if not isinstance(hashes, dict) or not {"SKILL.md", "release.json"}.issubset(hashes):
        raise InvalidRelease("missing file inventory")
    expected = {safe_path(path): value for path, value in hashes.items()}
    files: dict[str, bytes] = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        if sum(item.file_size for item in package.infolist()) > MAX_BYTES:
            raise InvalidRelease("archive too large")
        for item in package.infolist():
            if item.is_dir():
                continue
            if not item.filename.startswith(name + "/") or stat.S_ISLNK(item.external_attr >> 16):
                raise InvalidRelease("invalid archive member")
            relative = safe_path(item.filename[len(name) + 1:])
            if relative in files or relative not in expected:
                raise InvalidRelease("unexpected archive member")
            data = package.read(item)
            if digest(data) != expected[relative]:
                raise InvalidRelease("file hash mismatch")
            files[relative] = data
    if set(files) != set(expected) or skill_identity(files["SKILL.md"]) != (name, release["version"]):
        raise InvalidRelease("release identity mismatch")
    provenance = json.loads(files["release.json"])
    actual = {path: digest(data) for path, data in files.items() if path != "release.json"}
    if provenance != {"name": name, "version": release["version"], "files": actual}:
        raise InvalidRelease("release inventory mismatch")
    return files


def ensure_unmodified(skill_dir: Path, name: str, version: str) -> None:
    """Preserve edits to installed skill content; client metadata stays local."""
    record = skill_dir / "release.json"
    if not record.exists():
        return
    release = json.loads(record.read_bytes())
    if not isinstance(release, dict) or release.get("name") != name or release.get("version") != version:
        raise LocalChanges("release metadata changed")
    hashes = release.get("files")
    if not isinstance(hashes, dict) or "SKILL.md" not in hashes:
        raise LocalChanges("release inventory changed")
    for relative, expected in hashes.items():
        relative = safe_path(relative)
        if relative == "agents/openai.yaml":
            continue
        target = skill_dir / relative
        if not target.is_file() or digest(target.read_bytes()) != expected:
            raise LocalChanges("skill content changed")


def atomic_write(path: Path, data: bytes, mode: int) -> None:
    """Replace one regular file using a temporary file in the same directory."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".skill-update-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install_files(skill_dir: Path, files: dict[str, bytes]) -> None:
    """Install verified content, preserving client metadata and rolling back failures."""
    changes: list[tuple[Path, bytes | None, int]] = []
    ordered = sorted(files, key=lambda path: (path == "SKILL.md", path == "release.json", path))
    try:
        for relative in ordered:
            target = skill_dir / relative
            if relative == "agents/openai.yaml" and target.exists():
                continue
            if target.is_symlink() or not target.resolve().is_relative_to(skill_dir.resolve()):
                raise InvalidRelease("installed path is a symlink")
            old = target.read_bytes() if target.exists() else None
            if old == files[relative]:
                continue
            mode = stat.S_IMODE(target.stat().st_mode) if old is not None else 0o644
            changes.append((target, old, mode))
            atomic_write(target, files[relative], mode)
    except Exception:
        for target, old, mode in reversed(changes):
            if old is None:
                target.unlink(missing_ok=True)
            elif not target.exists() or target.read_bytes() != old:
                atomic_write(target, old, mode)
        raise


def update_skill(skill_dir: Path, catalog_url: str = CATALOG_URL) -> dict:
    """Check one catalog entry and apply only a newer verified release."""
    name, current = skill_identity((skill_dir / "SKILL.md").read_bytes())
    try:
        catalog = json.loads(fetch_bytes(catalog_url, catalog_url))
        if not isinstance(catalog, dict) or catalog.get("schemaVersion") != 1 or not isinstance(catalog.get("skills"), dict) or name not in catalog["skills"]:
            raise InvalidRelease("skill not in catalog")
        release = catalog["skills"][name]
        if not isinstance(release, dict):
            raise InvalidRelease("invalid release entry")
        latest = release["version"]
        comparison = (version_tuple(latest), version_tuple(current))
        if comparison[0] <= comparison[1]:
            return {"status": "current" if latest == current else "local_newer", "version": current}
        url = urljoin(catalog_url, "downloads/" + name + ".zip")
        if release.get("url") != url:
            raise InvalidRelease("unexpected archive URL")
        files = verified_files(fetch_bytes(url, catalog_url), name, release)
        ensure_unmodified(skill_dir, name, current)
        install_files(skill_dir, files)
        return {"status": "updated", "previousVersion": current, "version": latest, "reread": "SKILL.md"}
    except LocalChanges:
        return {"status": "blocked", "reason": "local_changes", "version": current}
    except PermissionError:
        return {"status": "blocked", "reason": "permissions", "version": current}
    except (URLError, TimeoutError, ConnectionError, OSError):
        return {"status": "unavailable", "reason": "network_or_install", "version": current}
    except (InvalidRelease, ValueError, KeyError, TypeError, zipfile.BadZipFile, UnicodeError):
        return {"status": "unavailable", "reason": "invalid_release", "version": current}


if __name__ == "__main__":
    try:
        result = update_skill(Path(__file__).resolve().parents[1])
    except (OSError, ValueError, UnicodeError):
        result = {"status": "blocked", "reason": "invalid_installation"}
    print(json.dumps(result, ensure_ascii=False))
