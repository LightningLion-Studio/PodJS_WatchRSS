#!/usr/bin/env python3
"""Compile real runner sources against cached Android APIs and execute their real allowlist.

No Gradle invocation, network download, ADB, APK install or Android stub execution.
"""
import argparse
from pathlib import Path
import re
import subprocess
import tempfile


def run(*command):
    return subprocess.run(command, check=True, text=True, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT).stdout


def cached_jar(cache, name):
    matches = sorted(cache.glob(f"*/transforms/*/transformed/{name}"))
    if not matches:
        raise SystemExit(f"Missing cached {name}; provide a populated --gradle-cache (no downloads attempted)")
    return matches[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--android-jar", type=Path,
                        default=Path.home() / "Android/Sdk/platforms/android-30/android.jar")
    parser.add_argument("--gradle-cache", type=Path, default=Path.home() / ".gradle/caches")
    options = parser.parse_args()
    harness = Path(__file__).resolve().parent
    package = "dev.podjs.tests.fontscale"
    source_root = harness / "java"
    classpath = [options.android_jar,
                 cached_jar(options.gradle_cache, "runner-1.7.0-api.jar"),
                 cached_jar(options.gradle_cache, "monitor-1.8.0-api.jar")]
    annotation = sorted(options.gradle_cache.glob(
        "modules-2/files-2.1/androidx.annotation/annotation/1.3.0/*/annotation-1.3.0.jar"))
    if not annotation:
        raise SystemExit("Missing cached androidx.annotation:annotation:1.3.0 (no downloads attempted)")
    classpath.append(annotation[0])
    if not options.android_jar.is_file():
        raise SystemExit(f"Android API jar does not exist: {options.android_jar}")
    with tempfile.TemporaryDirectory(prefix="watchrss-font-scale-offline-") as scratch:
        compiled = Path(scratch) / "classes"
        compiled.mkdir()
        sources = sorted(source_root.rglob("*.java")) + sorted((harness / "offline").rglob("*.java"))
        output = run("javac", "--release", "8", "-Werror", "-Xlint:all,-deprecation,-options", "-cp",
                     ":".join(str(path) for path in classpath), "-d", str(compiled),
                     *(str(path) for path in sources))
        if output.strip():
            print(output.strip())
        print(run("java", "-cp", str(compiled), package + ".FontScalePolicyTest").strip())
        # Audit actual compiled calls, not a second implementation of lifecycle injection.
        bytecode = run("javap", "-c", "-p", "-classpath", str(compiled),
                       package + ".IsolatedFontScaleRunner")
        forbidden = ("Resources.updateConfiguration", "ResourcesManager", "Settings$System.put",
                     "Settings$Global.put", "Settings$Secure.put", "UiAutomation.executeShellCommand",
                     "Runtime.exec", "ProcessBuilder", "Context.createConfigurationContext")
        for call in forbidden:
            if call in bytecode:
                raise AssertionError(f"Forbidden process/system configuration path: {call}")
        if bytecode.count("Activity.applyOverrideConfiguration:") != 1:
            raise AssertionError("The real runner must have exactly one local override call")
        match = re.search(r"public android.app.Activity newActivity\(java.lang.ClassLoader,.*?\n  public void callActivityOnCreate",
                          bytecode, re.S)
        if not match:
            raise AssertionError("Cannot identify compiled pre-attach newActivity method")
        pre_override = match.group(0).split("Activity.applyOverrideConfiguration:", 1)[0]
        for call in ("Activity.getResources", "Activity.getApplication", "Activity.getPackageName",
                     "ContextThemeWrapper.getResources", "Resources.getConfiguration"):
            if call in pre_override:
                raise AssertionError(f"Premature Activity context/resource access: {call}")
        if "Activity.getBaseContext:" not in pre_override:
            raise AssertionError("Missing pre-attach assertion")
        print("Android API 30 + runner 1.7.0 / monitor 1.8.0 javac: passed")
        print("Compiled runner audit: one Activity-local override; no global writes or pre-override Activity resources")
        print("Offline only: device lifecycle, font rendering and final APK manifest still require live verification")


if __name__ == "__main__":
    main()
