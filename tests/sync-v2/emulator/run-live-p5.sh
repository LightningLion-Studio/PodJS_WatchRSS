#!/usr/bin/env bash
# Explicit synthetic fixture and owned emulator only. Paths are caller supplied.
set -euo pipefail
framework=$(realpath "${1:?framework worktree required}")
serial=${2:?owned emulator required}
fixture=$(realpath "${3:?synthetic watch fixture required}")
evidence=${4:?evidence directory required}
[[ $serial =~ ^emulator-[0-9]+$ ]]
project=$(cd "$(dirname "$0")/../../.." && pwd)
[[ $(realpath "$project/node_modules/@podjs/framework") == "$framework/packages/framework" ]]
adb=${ANDROID_SDK_ROOT:?ANDROID_SDK_ROOT required}/platform-tools/adb
[[ $("$adb" -s "$serial" emu avd name | tr -d '\r' | head -1) == WrssP5WatchLive ]]
mkdir -p "$evidence"
evidence=$(realpath "$evidence")
watermark=${5:-"$evidence/../author-watermark.json"}
native="$framework/platforms/android/runtime/src/androidTest/java/dev/podjs/runtime/P5AccountIntegrationTest.java"
[[ ! -e $native ]]
cp "$project/tests/sync-v2/emulator/P5AccountIntegrationTest.java" "$native"
cleanup(){
 rm -f "$native"
 "$adb" -s "$serial" exec-out run-as dev.podjs.runtime.test cat files/syncv2-p5-live/author-watermark.json > "$evidence/watermark.returned.json" 2>/dev/null || true
 python3 "$project/tests/sync-v2/emulator/p5-watermark.py" "$fixture" "$watermark" "$evidence/watermark.returned.json" "$evidence/../watermarks"
 rm -f "$evidence/watermark.returned.json"
 "$adb" -s "$serial" shell run-as dev.podjs.runtime.test rm -f files/syncv2-p5-live/watch.json files/syncv2-p5-live/guest.js >/dev/null || true
}
trap cleanup EXIT
(cd "$project" && bun build tests/sync-v2/emulator/live-p5-guest.ts --target=browser --format=iife --outfile="$evidence/guest.js")
(cd "$framework/platforms/android" && ./gradlew :runtime:assembleDebugAndroidTest --max-workers=2 -PpodAbis=x86_64 --offline) > "$evidence/build.log" 2>&1
"$adb" -s "$serial" reverse tcp:18972 tcp:18972
"$adb" -s "$serial" install -r "$framework/platforms/android/runtime/build/outputs/apk/androidTest/debug/runtime-debug-androidTest.apk" > "$evidence/install.log"
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test mkdir -p files/syncv2-p5-live
"$adb" -s "$serial" exec-out run-as dev.podjs.runtime.test cat files/syncv2-p5-live/author-watermark.json > "$evidence/watermark.previous.json" 2>/dev/null || true
python3 "$project/tests/sync-v2/emulator/p5-watermark.py" "$fixture" "$watermark" "$evidence/watermark.previous.json" "$evidence/../watermarks"
rm -f "$evidence/watermark.previous.json"
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test rm -f files/syncv2-p5-live/author-watermark.json
if [[ -f $watermark ]]; then
 "$adb" -s "$serial" push "$watermark" /data/local/tmp/wrss-p5-watermark.json >/dev/null
 "$adb" -s "$serial" shell run-as dev.podjs.runtime.test cp /data/local/tmp/wrss-p5-watermark.json files/syncv2-p5-live/author-watermark.json
 "$adb" -s "$serial" shell rm /data/local/tmp/wrss-p5-watermark.json
fi
for file in watch.json guest.js; do
 source="$evidence/guest.js"
 if [[ $file == watch.json ]]; then source="$fixture"; fi
 "$adb" -s "$serial" push "$source" "/data/local/tmp/wrss-p5-$file" >/dev/null
 "$adb" -s "$serial" shell run-as dev.podjs.runtime.test cp "/data/local/tmp/wrss-p5-$file" "files/syncv2-p5-live/$file"
 "$adb" -s "$serial" shell rm "/data/local/tmp/wrss-p5-$file"
done
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test rm -f files/syncv2-p5-live/result.json
"$adb" -s "$serial" shell am instrument -w -e class dev.podjs.runtime.P5AccountIntegrationTest dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner > "$evidence/instrumentation.log" 2>&1
"$adb" -s "$serial" exec-out run-as dev.podjs.runtime.test cat files/syncv2-p5-live/result.json > "$evidence/result.json"
rg -q '^OK \(1 test\)' "$evidence/instrumentation.log"
