#!/usr/bin/env bash
# Explicit isolated test only. Never enable shell tracing around fixture I/O.
set -euo pipefail
framework=$(realpath "${1:?framework worktree required}")
[[ $framework != /home/wilf/data/PodJS/podjs-watch ]] || { echo 'Shared framework checkout is forbidden' >&2; exit 2; }
[[ $(git -C "$framework" rev-parse HEAD) == a48eafe* ]] || { echo 'Framework base mismatch' >&2; exit 2; }
serial=${2:?owned emulator serial required}
evidence=${3:?evidence directory required}
[[ $serial =~ ^emulator-[0-9]+$ ]] || { echo 'Physical devices are forbidden' >&2; exit 2; }
project=$(cd "$(dirname "$0")/../../.." && pwd)
[[ $(realpath "$project/node_modules/@podjs/framework") == "$framework/packages/framework" ]] || { echo 'Framework link mismatch' >&2; exit 2; }
fixture=/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/integration/watch.json
adb=${ANDROID_SDK_ROOT:-/home/wilf/Android/Sdk}/platform-tools/adb
native_test="$framework/platforms/android/runtime/src/androidTest/java/dev/podjs/runtime/SyncV2IntegrationTest.java"
[[ ! -e $native_test ]] || { echo 'Test destination exists; do not overwrite it' >&2; exit 2; }
mkdir -p "$evidence"
evidence=$(realpath "$evidence")
cp "$project/tests/sync-v2/emulator/SyncV2IntegrationTest.java" "$native_test"
trap 'rm -f "$native_test"' EXIT
(cd "$project" && bun build tests/sync-v2/emulator/guest.ts --target=browser --format=iife --outfile="$evidence/guest.js")
(cd "$framework/platforms/android" && ./gradlew :runtime:assembleDebugAndroidTest -PpodAbis=x86_64 --offline) > "$evidence/build.log" 2>&1
"$adb" -s "$serial" reverse tcp:18942 tcp:18942
"$adb" -s "$serial" install -r "$framework/platforms/android/runtime/build/outputs/apk/androidTest/debug/runtime-debug-androidTest.apk"
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test mkdir -p files/syncv2-integration
"$adb" -s "$serial" push "$fixture" /data/local/tmp/wrss-watch-fixture.json
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test cp /data/local/tmp/wrss-watch-fixture.json files/syncv2-integration/watch.json
"$adb" -s "$serial" shell rm /data/local/tmp/wrss-watch-fixture.json
"$adb" -s "$serial" push "$evidence/guest.js" /data/local/tmp/wrss-guest.js
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test cp /data/local/tmp/wrss-guest.js files/syncv2-integration/guest.js
"$adb" -s "$serial" shell rm /data/local/tmp/wrss-guest.js
"$adb" -s "$serial" shell am instrument -w -e class dev.podjs.runtime.SyncV2IntegrationTest dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner > "$evidence/instrumentation.log" 2>&1
"$adb" -s "$serial" exec-out run-as dev.podjs.runtime.test cat files/syncv2-integration/result.json > "$evidence/result.json"
rg -q '^OK \(1 test\)' "$evidence/instrumentation.log"
