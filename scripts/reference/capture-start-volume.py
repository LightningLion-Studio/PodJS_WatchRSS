#!/usr/bin/env python3
"""Compile native volume policies unchanged and capture playback start decisions."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

project = Path(__file__).resolve().parents[2]
native = project.parent / "Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/media/MediaVolumePolicy.kt"
settings = native.parent.parent / "settings/MediaPlaybackStartVolumeLimit.kt"
cache = Path.home() / ".gradle/caches/modules-2/files-2.1"
dependencies = [
    ("org.jetbrains.kotlin", "kotlin-compiler-embeddable", "2.2.21"),
    ("org.jetbrains.kotlin", "kotlin-stdlib", "2.2.21"),
    ("org.jetbrains.kotlin", "kotlin-script-runtime", "2.2.21"),
    ("org.jetbrains.kotlin", "kotlin-reflect", "1.6.10"),
    ("org.jetbrains.intellij.deps", "trove4j", "1.0.20200330"),
    ("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"),
    ("org.jetbrains", "annotations", "13.0"),
]
jars = [next((cache / group / name / version).glob("*/*.jar")) for group, name, version in dependencies]
classpath = ":".join(map(str, jars))
with tempfile.TemporaryDirectory(prefix="watchrss-volume-reference-") as folder:
    subprocess.run(["java", "-cp", classpath, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-classpath", classpath, "-d", folder, str(native), str(settings), str(Path(__file__).with_name("MediaStartVolumeProbe.kt"))], check=True)
    output = subprocess.check_output(["java", "-cp", folder + ":" + classpath, "com.lightningstudio.watchrss.data.media.MediaStartVolumeProbeKt"], text=True)
fixture = project / "tests/fixtures/media-start-volume-native.json"
fixture.parent.mkdir(parents=True, exist_ok=True)
fixture.write_text(json.dumps({"source": str(native.relative_to(project.parent)), "sha256": hashlib.sha256(native.read_bytes()).hexdigest(), "settingsSource": str(settings.relative_to(project.parent)), "settingsSha256": hashlib.sha256(settings.read_bytes()).hexdigest(), "cases": json.loads(output)}, ensure_ascii=False, indent=2) + "\n")
print(f"Captured {len(json.loads(output))} native cases: {fixture}")
