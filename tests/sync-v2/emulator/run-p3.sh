#!/usr/bin/env bash
# Synthetic emulator only. No login fixtures, account or external backend.
set -euo pipefail
framework=$(realpath "${1:?framework worktree required}")
serial=${2:?owned emulator serial required}
evidence=${3:?evidence directory required}
[[ $framework != /home/wilf/data/PodJS/podjs-watch ]] || { echo 'Shared framework checkout is forbidden' >&2; exit 2; }
[[ $serial =~ ^emulator-[0-9]+$ ]] || { echo 'Physical devices are forbidden' >&2; exit 2; }
project=$(cd "$(dirname "$0")/../../.." && pwd)
[[ $(realpath "$project/node_modules/@podjs/framework") == "$framework/packages/framework" ]] || { echo 'Framework link mismatch' >&2; exit 2; }
mkdir -p "$evidence"
evidence=$(realpath "$evidence")
native_test="$framework/platforms/android/runtime/src/androidTest/java/dev/podjs/runtime/P3ContentGuestTest.java"
[[ ! -e $native_test ]] || { echo 'Test destination exists; do not overwrite it' >&2; exit 2; }
cp "$project/tests/sync-v2/emulator/P3ContentGuestTest.java" "$native_test"
trap 'rm -f "$native_test"' EXIT
if [[ ! -f $framework/platforms/android/runtime/prebuilt/x86_64/libpodjs_runtime.a ]]; then
 (cd "$framework" && CARGO_BUILD_JOBS=4 PODJS_ANDROID_ABIS=x86_64 bash scripts/build-android-runtime.sh) > "$evidence/rust-build.log" 2>&1
fi
(cd "$project" && bun build tests/sync-v2/emulator/p3-guest.ts --target=browser --format=iife --outfile="$evidence/p3-guest.js")
(cd "$framework/platforms/android" && ./gradlew :runtime:assembleDebugAndroidTest --max-workers=2 -PpodAbis=x86_64 --offline) > "$evidence/build.log" 2>&1
adb=${ANDROID_SDK_ROOT:-/home/wilf/Android/Sdk}/platform-tools/adb
"$adb" -s "$serial" install -r "$framework/platforms/android/runtime/build/outputs/apk/androidTest/debug/runtime-debug-androidTest.apk"
"$adb" -s "$serial" push "$evidence/p3-guest.js" /data/local/tmp/wrss-p3-guest.js
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test cp /data/local/tmp/wrss-p3-guest.js files/wrss-p3-guest.js
"$adb" -s "$serial" shell rm /data/local/tmp/wrss-p3-guest.js
"$adb" -s "$serial" shell am instrument -w -e class dev.podjs.runtime.PodContentFilesDeviceTest,dev.podjs.runtime.P3ContentGuestTest dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner > "$evidence/instrumentation.log" 2>&1
"$adb" -s "$serial" exec-out run-as dev.podjs.runtime.test cat files/wrss-p3-result.json > "$evidence/result.json"
"$adb" -s "$serial" exec-out run-as dev.podjs.runtime.test cat files/wrss-p3-outcome.json > "$evidence/outcome.json"
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test rm files/wrss-p3-guest.js files/wrss-p3-result.json files/wrss-p3-outcome.json
rg -q '^OK \(3 tests\)' "$evidence/instrumentation.log"
