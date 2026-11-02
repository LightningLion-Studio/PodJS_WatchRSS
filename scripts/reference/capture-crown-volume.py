#!/usr/bin/env python3
"""Compile native volume policies unchanged and capture continuous crown guard decisions."""
import hashlib
import json
import re
from pathlib import Path
import subprocess
import tempfile

project = Path(__file__).resolve().parents[2]
native = project.parent / "Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/data/media/MediaVolumePolicy.kt"
settings = native.parent.parent / "settings/MediaPlaybackStartVolumeLimit.kt"
input_source = native.parent.parent.parent / "ui/input/DigitalCrownInput.kt"
overlay_source = native.parent.parent.parent / "ui/components/PlayerVolumeOverlay.kt"
def constant(path, name):
    return re.search(r"private const val " + name + r" = ([0-9.]+)f?", path.read_text()).group(1)
step=constant(input_source,"DIGITAL_CROWN_VOLUME_STEP")
baseline_sensitivity=constant(overlay_source,"VOLUME_SENSITIVITY_PERCENT")
# T-1201-CROWN: run the unchanged Kotlin guard with the requested 1/3 profile.
sensitivity="0.02"
cap=constant(overlay_source,"DIGITAL_CROWN_SESSION_CAP_PERCENT")
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
    probe = Path(folder) / "CrownVolumeProbe.kt"
    probe.write_text(Path(__file__).with_name("CrownVolumeProbe.kt").read_text().replace("-raw*.01f",f"-raw*{step}f").replace("(max-min)*.06f",f"(max-min)*{sensitivity}f").replace("volumeForPercent(.21f",f"volumeForPercent({cap}f"))
    subprocess.run(["java", "-cp", classpath, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-classpath", classpath, "-d", folder, str(native), str(settings), str(probe)], check=True)
    output = subprocess.check_output(["java", "-cp", folder + ":" + classpath, "com.lightningstudio.watchrss.data.media.CrownVolumeProbeKt"], text=True)
fixture = project / "tests/fixtures/crown-volume-native.json"
fixture.parent.mkdir(parents=True, exist_ok=True)
fixture.write_text(json.dumps({"source": str(native.relative_to(project.parent)), "sha256": hashlib.sha256(native.read_bytes()).hexdigest(), "settingsSource": str(settings.relative_to(project.parent)), "settingsSha256": hashlib.sha256(settings.read_bytes()).hexdigest(), "inputSha256": hashlib.sha256(input_source.read_bytes()).hexdigest(), "overlaySha256": hashlib.sha256(overlay_source.read_bytes()).hexdigest(), "nativeBaselineConstants": {"step":step,"sensitivity":baseline_sensitivity,"cap":cap}, "profileOverride": "T-1201-CROWN: sensitivity / 3; unchanged Kotlin guard", "extractedConstants": {"step":step,"sensitivity":sensitivity,"cap":cap}, "cases": json.loads(output)}, ensure_ascii=False, indent=2) + "\n")
print(f"Captured {len(json.loads(output))} native cases: {fixture}")
