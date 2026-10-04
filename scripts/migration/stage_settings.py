#!/usr/bin/env python3
"""Decode native DataStore preferences into private PodJS settings/onboarding state."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import tarfile


PREFERENCE_PATH = "files/datastore/settings.preferences_pb.preferences_pb"


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def varint(data: bytes, offset: int) -> tuple[int, int]:
    result = shift = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        result |= (byte & 0x7f) << shift
        if byte < 128:
            return result, offset
        shift += 7
        if shift >= 70:
            break
    raise ValueError("Invalid DataStore varint")


def fields(data: bytes):
    offset = 0
    while offset < len(data):
        tag, offset = varint(data, offset)
        field, wire = tag >> 3, tag & 7
        if field == 0:
            raise ValueError("Invalid DataStore field")
        if wire == 0:
            value, offset = varint(data, offset)
        elif wire == 1:
            value = data[offset:offset + 8]
            offset += 8
        elif wire == 2:
            length, offset = varint(data, offset)
            value = data[offset:offset + length]
            offset += length
        elif wire == 5:
            value = data[offset:offset + 4]
            offset += 4
        else:
            raise ValueError("Unsupported DataStore wire type")
        if offset > len(data):
            raise ValueError("Truncated DataStore field")
        yield field, wire, value


def value(message: bytes) -> object:
    entries = list(fields(message))
    if len(entries) != 1:
        raise ValueError("Unexpected DataStore value structure")
    field, wire, raw = entries[0]
    if field == 1 and wire == 0:
        return bool(raw)
    if field == 2 and wire == 5:
        return struct.unpack("<f", raw)[0]
    if field in (3, 4) and wire == 0:
        bits = 32 if field == 3 else 64
        return raw - (1 << bits) if raw >= (1 << (bits - 1)) else raw
    if field == 5 and wire == 2:
        return raw.decode("utf-8")
    if field == 7 and wire == 1:
        return struct.unpack("<d", raw)[0]
    raise ValueError("Unsupported DataStore preference type")


def decode(data: bytes) -> dict[str, object]:
    result: dict[str, object] = {}
    for field, wire, entry in fields(data):
        if field != 1 or wire != 2:
            raise ValueError("Unexpected DataStore preference map field")
        pair = list(fields(entry))
        key_fields = [raw for number, kind, raw in pair if number == 1 and kind == 2]
        value_fields = [raw for number, kind, raw in pair if number == 2 and kind == 2]
        if len(key_fields) != 1 or len(value_fields) != 1:
            raise ValueError("Malformed DataStore preference entry")
        key = key_fields[0].decode("utf-8")
        if key in result:
            raise ValueError("Duplicate DataStore preference")
        result[key] = value(value_fields[0])
    return result


def expect(values: dict[str, object], key: str, kind: type, default):
    entry = values.get(key, default)
    if type(entry) is not kind:
        raise ValueError(f"Unexpected type for native preference {key}")
    return entry


def run(archive_path: Path, output: Path, report: Path) -> None:
    if not archive_path.is_file():
        raise ValueError("Native app file archive is required")
    if output.exists() or report.exists():
        raise ValueError("Refusing to overwrite staged settings or report")
    with tarfile.open(archive_path) as archive:
        stream = archive.extractfile(PREFERENCE_PATH)
        if stream is None:
            raise ValueError("Native settings DataStore is absent")
        source = stream.read()
    values = decode(source)
    settings = {
        "llmEnabled": True, "llmAutoSummarize": False,
        "llmPromptPreset": 1, "llmShowTokenUsage": False,
        "fontSizeSp": expect(values, "reading_font_size_sp", int, 14),
        "speechRate": expect(values, "tts_speed", float, 1.0),
        "readerAutoStart": expect(values, "reader_auto_scroll_enabled", bool, False),
        "readerScrollSpeed": expect(values, "reader_auto_scroll_lines_per_second", float, 2.0),
        "mediaVolumeControl": expect(values, "media_volume_control_enabled", bool, True),
        "mediaVolumeGuard": expect(values, "media_volume_guard_enabled", bool, False),
        "playbackStartVolumeLimit": values.get("media_playback_start_volume_limit_percent"),
        "cacheLimitMb": expect(values, "cache_limit_bytes", int, 512 * 1024 * 1024) // (1024 * 1024),
        "mediaCacheMode": {0: "关闭", 1: "前 4 项", 2: "全部"}.get(
            expect(values, "rss_inline_image_prefetch_mode", int, 1)
        ),
        "syncMediaKeepAlive": expect(values, "sync_media_keep_alive_enabled", bool, False),
        "shareUseSystem": expect(values, "share_use_system", bool, False),
    }
    if settings["mediaCacheMode"] is None:
        raise ValueError("Unknown native image prefetch mode")
    for native, target in (("llm_enabled", "llmEnabled"),
                           ("llm_auto_summarize", "llmAutoSummarize"),
                           ("llm_show_token_usage", "llmShowTokenUsage")):
        if native in values:
            settings[target] = expect(values, native, bool, False)
    if "llm_prompt_preset" in values:
        settings["llmPromptPreset"] = expect(values, "llm_prompt_preset", int, 0) + 1
    onboard = {
        "oobeSeenVersion": expect(values, "oobe_seen_version", int, 0),
        "privacyPolicyAgreedVersion": expect(values, "privacy_policy_agreed_version", int, 0),
    }
    state = {"watchrss.settings": settings, "watchrss.onboarding": onboard}
    output.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")) + "\n")
    os.chmod(output, 0o600)
    used = {"reading_font_size_sp", "tts_speed", "reader_auto_scroll_enabled",
            "reader_auto_scroll_lines_per_second", "media_volume_control_enabled",
            "media_volume_guard_enabled", "media_playback_start_volume_limit_percent",
            "cache_limit_bytes", "rss_inline_image_prefetch_mode", "sync_media_keep_alive_enabled",
            "share_use_system", "llm_enabled", "llm_auto_summarize", "llm_show_token_usage",
            "llm_prompt_preset", "oobe_seen_version", "privacy_policy_agreed_version"}
    info = {
        "sourceTarSha256": sha256(archive_path), "dataStoreSha256": hashlib.sha256(source).hexdigest(),
        "settingsStageSha256": sha256(output), "sourceKeys": len(values),
        "mappedKeys": len(values.keys() & used),
        "legacyThemeKeyPresent": "reading_theme_dark" in values,
        "temporaryHintKeys": sum(key.startswith("temp_original_mode_hint_") for key in values),
        "otherUnmappedKeys": sorted(key for key in values if key not in used
                                    and key != "reading_theme_dark"
                                    and not key.startswith("temp_original_mode_hint_")),
        "activationReady": False,
    }
    report.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n")
    os.chmod(report, 0o600)
    print(json.dumps(info))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--files-tar", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    run(args.files_tar, args.out, args.report)
