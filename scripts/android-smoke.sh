#!/usr/bin/env bash
set -euo pipefail
app_root="$(cd "$(dirname "$0")/.." && pwd)"
framework_root="$(cd "$app_root/../../PodJS/podjs-watch" && pwd)"
device="${ANDROID_SERIAL:-$(adb -d get-serialno 2>/dev/null || true)}"
if [[ -z "$device" || "$device" == unknown ]]; then
  device="$(adb -e get-serialno 2>/dev/null || true)"
fi
[[ -n "$device" && "$device" != unknown ]] || { echo "Set ANDROID_SERIAL to a connected watch or emulator." >&2; exit 1; }
export ANDROID_SERIAL="$device"
abi="$(adb -s "$device" shell getprop ro.product.cpu.abi | tr -d '\r')"
case "$abi" in
  x86_64) abis=x86_64 ;;
  arm64-v8a|armeabi-v7a) abis=armeabi-v7a,arm64-v8a ;;
  *) echo "Unsupported device ABI: $abi" >&2; exit 1 ;;
esac
ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}" PODJS_ANDROID_ABIS="$abis" bash "$framework_root/scripts/build-android-runtime.sh"
cd "$app_root"
bun run build
cd "$framework_root/platforms/android"
./gradlew :androidApp:connectedDebugAndroidTest \
  "-PpodAbis=$abis" \
  -PpodAppId=com.lightningstudio.watchrss.podjs \
  -PpodAppName=WatchRSS \
  -PpodVersionName=0.1.0-dev -PpodVersionCode=1 \
  "-PpodDistDir=$framework_root/dist/projects/com.lightningstudio.watchrss.podjs/android-watch" \
  "-PpodTestAssetsDir=$app_root/tests/android/assets" \
  "-PpodTestSourceDir=$app_root/tests/android/java" \
  "-Pandroid.testInstrumentationRunnerArguments.class=${PODJS_TEST_CLASS:-dev.podjs.androidwatch.WatchRssSmokeTest}" \
  -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true
