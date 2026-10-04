#!/usr/bin/env python3
"""Create a private ReaderPresetStore JSON stage from Room v18 and preferences."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tarfile
import xml.etree.ElementTree as ET


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def preferences(archive_path: Path) -> dict[str, object]:
    with tarfile.open(archive_path) as archive:
        stream = archive.extractfile("shared_prefs/reader_preset_state.xml")
        if stream is None:
            raise ValueError("Reader selection preferences are absent")
        root = ET.fromstring(stream.read())
    result: dict[str, object] = {}
    for node in root:
        name = node.attrib.get("name")
        if not name:
            continue
        raw = node.attrib.get("value") if node.tag != "string" else node.text
        if node.tag == "boolean":
            result[name] = raw == "true"
        elif node.tag in ("int", "long"):
            result[name] = int(raw or "0")
        elif node.tag in ("string", "float"):
            result[name] = raw or ""
    return result


def run(database: Path, files_tar: Path, output: Path, report: Path) -> None:
    if not database.is_file() or not files_tar.is_file():
        raise ValueError("Native database and preferences archive are required")
    if output.exists() or report.exists():
        raise ValueError("Refusing to overwrite staged reader state or report")
    db = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        if db.execute("PRAGMA user_version").fetchone()[0] != 18:
            raise ValueError("Native database is not Room v18")
        prefs = preferences(files_tar)
        mode = prefs.get("reader_theme_mode", "DARK")
        if mode not in ("DARK", "LIGHT", "SYSTEM"):
            raise ValueError("Unrecognized native reader theme mode")
        schedule_mode = prefs.get("watch_theme_schedule_mode", "FIXED_TIME")
        if schedule_mode not in ("FIXED_TIME", "SUNRISE_SUNSET"):
            raise ValueError("Unrecognized native theme schedule")
        nullable = lambda key: str(prefs[key]) if key in prefs and prefs[key] else None
        latitude = nullable("watch_sun_latitude")
        longitude = nullable("watch_sun_longitude")
        selection = {
            "mode": mode,
            "lightPresetId": nullable("light_preset_id") or nullable("active_preset_id"),
            "darkPresetId": nullable("dark_preset_id"),
            "darkFollowsLight": prefs.get("dark_follows_light", True),
        }
        schedule = {
            "mode": schedule_mode,
            "lightStartMinutes": int(prefs.get("watch_light_start_minutes", 420)),
            "darkStartMinutes": int(prefs.get("watch_dark_start_minutes", 1140)),
            "latitude": float(latitude) if latitude is not None else None,
            "longitude": float(longitude) if longitude is not None else None,
            "locationUpdatedAt": int(prefs.get("watch_sun_location_updated_at", 0)),
        }
        if not 0 <= schedule["lightStartMinutes"] <= 1439 or not 0 <= schedule["darkStartMinutes"] <= 1439:
            raise ValueError("Native reader schedule time is invalid")
        if schedule["latitude"] is not None and abs(schedule["latitude"]) > 90:
            raise ValueError("Native reader latitude is invalid")
        if schedule["longitude"] is not None and abs(schedule["longitude"]) > 180:
            raise ValueError("Native reader longitude is invalid")
        def rows(table: str) -> list[dict[str, object]]:
            return [dict(row) for row in db.execute(f'SELECT * FROM "{table}"')]
        presets = rows("reader_presets")
        fonts = rows("reader_font_assets")
        backgrounds = rows("reader_background_assets")
        deletions = rows("reader_deletions")
        for row in presets + fonts + backgrounds:
            row["deleted"] = bool(row["deleted"])
        for row in backgrounds:
            row["posterAssetId"] = row["posterAssetId"] or ""
        state = {
            "version": 1,
            "records": presets,
            "assets": {"fonts": fonts, "backgrounds": backgrounds, "deletions": deletions},
            "selection": selection,
            "schedule": schedule,
        }
        output.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")) + "\n")
        os.chmod(output, 0o600)
        info = {
            "nativeDbSha256": sha256(database), "sourceTarSha256": sha256(files_tar),
            "readerStateSha256": sha256(output),
            "presetCount": len(presets), "fontMetadataCount": len(fonts),
            "backgroundMetadataCount": len(backgrounds), "deletionCount": len(deletions),
            "selectionCopied": True, "scheduleCopied": True,
            "activationReady": False,
        }
        report.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n")
        os.chmod(report, 0o600)
        print(json.dumps(info))
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-db", type=Path, required=True)
    parser.add_argument("--files-tar", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    run(args.native_db, args.files_tar, args.out, args.report)
