#!/usr/bin/env python3
"""Stage native article/reader files under PodJS-relative paths, without deployment."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sqlite3
import tarfile


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def run(database: Path, archive_path: Path, output: Path, report: Path) -> None:
    if not database.is_file() or not archive_path.is_file():
        raise ValueError("Native database and file archive are required")
    if output.exists() or report.exists():
        raise ValueError("Refusing to overwrite staged files or report")
    partial = output.with_name(output.name + ".partial")
    if partial.exists():
        raise ValueError("An earlier partial file stage exists")
    native = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
    try:
        if native.execute("PRAGMA user_version").fetchone()[0] != 18:
            raise ValueError("Native database is not Room v18")
        partial.mkdir(mode=0o700)
        copied: dict[str, tuple[int, str]] = {}
        try:
            with tarfile.open(archive_path) as archive:
                for member in archive:
                    path = PurePosixPath(member.name)
                    if path.is_absolute() or ".." in path.parts or path.parts[:1] != ("files",):
                        continue
                    relative = PurePosixPath(*path.parts[1:])
                    if not (relative.parts[:1] == ("article_content",) or
                            relative.parts[:2] in (("reader_assets", "fonts"),
                                                   ("reader_assets", "backgrounds"),
                                                   ("reader_assets", "variants"),
                                                   ("offline", "rss"))):
                        continue
                    if path.name.endswith((".part", ".part.meta")):
                        continue
                    if member.isdir():
                        continue
                    if not member.isfile() or member.issym() or member.islnk():
                        raise ValueError("Unexpected native asset entry type")
                    expected_depth = 2 if relative.parts[0] == "article_content" else 4 if relative.parts[0] == "offline" else 3
                    if len(relative.parts) != expected_depth:
                        raise ValueError("Unexpected nested native asset path")
                    key = str(relative)
                    if key in copied:
                        raise ValueError("Duplicate native asset archive entry")
                    dest = partial.joinpath(*relative.parts)
                    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    digest = hashlib.sha256()
                    size = 0
                    source = archive.extractfile(member)
                    if source is None:
                        raise ValueError("Unreadable native asset")
                    with source, dest.open("xb") as sink:
                        while block := source.read(1024 * 1024):
                            sink.write(block)
                            digest.update(block)
                            size += len(block)
                    os.chmod(dest, 0o600)
                    if size != member.size:
                        raise ValueError("Native asset length mismatch")
                    copied[key] = (size, digest.hexdigest())
            markers = set()
            for column in ("content", "originalContent"):
                for (value,) in native.execute(
                    f"SELECT {column} FROM rss_items WHERE {column} LIKE 'watchrss-watch-content:%'"
                ):
                    if value:
                        markers.add(value.removeprefix("watchrss-watch-content:"))
            missing_markers = sum("article_content/" + name not in copied for name in markers)
            if missing_markers:
                raise ValueError("A referenced article content file is missing")
            offline_paths = []
            for (path,) in native.execute("SELECT localPath FROM offline_media WHERE localPath IS NOT NULL"):
                prefix = "/files/"
                if prefix not in path:
                    raise ValueError("Native offline media path is outside app files")
                relative = path.split(prefix, 1)[1]
                if not relative.startswith("offline/rss/") or ".." in PurePosixPath(relative).parts:
                    raise ValueError("Unsafe native offline media path")
                offline_paths.append(relative)
            if any(path not in copied for path in offline_paths):
                raise ValueError("A referenced native offline media file is missing")
            font_rows = native.execute(
                "SELECT fileName,sha256,byteCount FROM reader_font_assets WHERE deleted=0"
            ).fetchall()
            for name, digest, count in font_rows:
                if copied.get("reader_assets/fonts/" + name) != (count, digest.lower()):
                    raise ValueError("An active reader font failed length/hash verification")
            background_rows = native.execute(
                "SELECT kind,masterFileName,sha256,byteCount,variantsJson FROM reader_background_assets WHERE deleted=0"
            ).fetchall()
            missing_backgrounds = sum(
                copied.get("reader_assets/backgrounds/" + name) != (count, digest.lower())
                for _, name, digest, count, _ in background_rows
            )
            verified_variants = 0
            usable_backgrounds = 0
            for _kind, name, digest, count, raw_variants in background_rows:
                variants = json.loads(raw_variants or "{}")
                if not isinstance(variants, dict):
                    raise ValueError("Invalid native background variant metadata")
                valid_keys: set[str] = set()
                for key, record in variants.items():
                    if not isinstance(record, dict):
                        raise ValueError("Invalid native background variant")
                    file_name, size, variant_hash = record.get("fileName"), record.get("byteCount"), record.get("sha256")
                    if not isinstance(file_name, str) or not isinstance(size, int) or not isinstance(variant_hash, str):
                        raise ValueError("Incomplete native background variant")
                    if copied.get("reader_assets/variants/" + file_name) != (size, variant_hash.lower()):
                        raise ValueError("An active reader background variant failed length/hash verification")
                    verified_variants += 1
                    valid_keys.add(key)
                master_valid = copied.get("reader_assets/backgrounds/" + name) == (count, digest.lower())
                if master_valid or "watch" in valid_keys:
                    usable_backgrounds += 1
            os.replace(partial, output)
            info = {
                "nativeDbSha256": sha256(database), "sourceTarSha256": sha256(archive_path),
                "copiedFiles": len(copied), "copiedBytes": sum(size for size, _ in copied.values()),
                "referencedArticleFiles": len(markers), "missingArticleFiles": 0,
                "referencedOfflineMediaFiles": len(offline_paths), "missingOfflineMediaFiles": 0,
                "verifiedActiveFonts": len(font_rows),
                "activeBackgroundMasters": len(background_rows),
                "missingOrInvalidActiveBackgroundMasters": missing_backgrounds,
                "verifiedActiveBackgroundVariants": verified_variants,
                "usableActiveBackgrounds": usable_backgrounds,
                "activationReady": False,
            }
            report.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n")
            os.chmod(report, 0o600)
            print(json.dumps(info))
        except Exception:
            shutil.rmtree(partial, ignore_errors=True)
            raise
    finally:
        native.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-db", type=Path, required=True)
    parser.add_argument("--files-tar", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    run(args.native_db, args.files_tar, args.out, args.report)
