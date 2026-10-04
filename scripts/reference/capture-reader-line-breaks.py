#!/usr/bin/env python3
"""Archive actual DetailTextBlock line layouts from the isolated Android reference test."""
from pathlib import Path
import hashlib
import json
import subprocess
import datetime

project = Path(__file__).resolve().parents[2]
source = "/sdcard/Android/data/com.lightningstudio.watchrss.reference/files/reference-reader-line-breaks.json"
raw = subprocess.check_output(["adb", "-s", "e3aca8af", "exec-out", "cat", source])
data = json.loads(raw)
assert data["complete"] and len(data["cases"]) == data["expectedCases"] == 288
sources = [
    project / "tests/reference/target/kotlin/ReaderLineBreakProbe.kt",
    project / "tests/reference/ReaderLineBreakReferenceTest.kt",
    project.parent / "Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/rss/DetailContentBlocks.kt",
    project.parent / "Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/rss/DetailHeaderActions.kt",
    project.parent / "Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/reader/ReaderPresetRuntime.kt",
]
data.update(device="e3aca8af / OWW242 / Android 11", capturedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), sources={str(path.relative_to(project.parent)):hashlib.sha256(path.read_bytes()).hexdigest() for path in sources})
data["scope"] = "Production Compose DetailTextBlock layouts compared with Android StaticLayout using the resolved native typeface, exact pixel width, size, mode and no hyphenation; does not validate PodJS layout."
for case in data["cases"]:
    assert case["composeEnds"][-1] == len(case["text"].encode("utf-16-le")) // 2
    assert all(start <= end for start,end in zip([0]+case["composeEnds"],case["composeEnds"]))
fixture = project / "tests/fixtures/reader-line-breaks-native.json"
fixture.write_text(json.dumps(data, ensure_ascii=False, indent=2)+"\n")
print(json.dumps({"cases":len(data["cases"]),"platformMatchesCompose":sum(case["staticMatchesCompose"] for case in data["cases"]),"fixture":str(fixture)},indent=2))
