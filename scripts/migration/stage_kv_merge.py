#!/usr/bin/env python3
"""Prepare a private PodJS KV merge without touching a live watch package.

The current PodJS onboarding decision is authoritative. This script refuses
to create or replace that decision from the native application's preference.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path


KEYS = ("watchrss.settings", "watchrss.reader-presets")
MAX_KV_BYTES = 4 * 1024 * 1024


def read_object(path: Path) -> dict:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def stage(base: Path, settings: Path, reader: Path, output: Path, report: Path) -> None:
    if output.exists() or report.exists():
        raise ValueError("Refusing to overwrite a stage or report")
    for path in (base, settings, reader):
        if not path.is_file():
            raise ValueError(f"Input missing: {path}")
    current = read_object(base)
    if "watchrss.onboarding" not in current:
        raise ValueError("PodJS onboarding has not been completed on the device")
    if any(key in current for key in KEYS):
        raise ValueError("PodJS settings or reader presets already exist; conflict review is required")
    setting_state = read_object(settings)
    if set(setting_state) != {"watchrss.settings", "watchrss.onboarding"}:
        raise ValueError("Unexpected settings stage keys")
    reader_state = read_object(reader)
    if reader_state.get("version") != 1 or not isinstance(reader_state.get("records"), list):
        raise ValueError("Unexpected reader stage format")
    merged = dict(current)
    merged["watchrss.settings"] = setting_state["watchrss.settings"]
    merged["watchrss.reader-presets"] = reader_state
    raw = json.dumps(merged, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_KV_BYTES:
        raise ValueError("Merged PodJS KV exceeds the host quota")
    output.write_bytes(raw)
    os.chmod(output, 0o600)
    info = {
        "baseKvSha256": sha256(base), "settingsStageSha256": sha256(settings),
        "readerStageSha256": sha256(reader), "mergedKvSha256": sha256(output),
        "preservedExistingKeys": len(current), "mergedKeys": list(KEYS),
        "onboardingPreserved": merged["watchrss.onboarding"] == current["watchrss.onboarding"],
        "outputBytes": len(raw),
    }
    report.write_text(json.dumps(info, ensure_ascii=False, indent=2) + "\n")
    os.chmod(report, 0o600)
    print(json.dumps({"outputBytes": len(raw), "onboardingPreserved": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-kv", type=Path, required=True)
    parser.add_argument("--settings-state", type=Path, required=True)
    parser.add_argument("--reader-state", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    stage(args.base_kv, args.settings_state, args.reader_state, args.out, args.report)
