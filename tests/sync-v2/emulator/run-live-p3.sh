#!/usr/bin/env bash
# Opt-in isolated backend + owned emulator only. Never trace fixture I/O.
set -euo pipefail
framework=$(realpath "${1:?framework required}")
serial=${2:?owned emulator required}
evidence=${3:?evidence required}
[[ $framework == /home/wilf/data/PodJS/podjs-watch.wt-syncv2-p3 ]]
[[ $serial =~ ^emulator-[0-9]+$ ]]
project=$(cd "$(dirname "$0")/../../.." && pwd)
[[ $(realpath "$project/node_modules/@podjs/framework") == "$framework/packages/framework" ]]
adb=${ANDROID_SDK_ROOT:-/home/wilf/Android/Sdk}/platform-tools/adb
[[ $("$adb" -s "$serial" emu avd name | tr -d '\r' | head -1) == WrssP3WatchLive ]]
native="$framework/platforms/android/runtime/src/androidTest/java/dev/podjs/runtime/P3LiveIntegrationTest.java"
[[ ! -e $native ]]
mkdir -p "$evidence"
evidence=$(realpath "$evidence")
python3 "$project/tests/sync-v2/emulator/live-p3-watermark.py" "$evidence/../author-watermark.json"
cp "$project/tests/sync-v2/emulator/P3LiveIntegrationTest.java" "$native"
trap 'rm -f "$native"' EXIT
(cd "$project" && bun build tests/sync-v2/emulator/live-p3-guest.ts --target=browser --format=iife --outfile="$evidence/guest.js")
(cd "$framework/platforms/android" && ./gradlew :runtime:assembleDebugAndroidTest --max-workers=2 -PpodAbis=x86_64 --offline) > "$evidence/build.log" 2>&1
"$adb" -s "$serial" reverse tcp:18942 tcp:18942
"$adb" -s "$serial" install -r "$framework/platforms/android/runtime/build/outputs/apk/androidTest/debug/runtime-debug-androidTest.apk"
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test mkdir -p files/syncv2-p3-live
for file in watch.json guest.js resume-watermark.json; do
 source="$evidence/guest.js"
 if [[ $file == watch.json ]]; then source=/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/integration/watch.json; fi
 if [[ $file == resume-watermark.json ]]; then source="$evidence/../author-watermark.json"; fi
 "$adb" -s "$serial" push "$source" "/data/local/tmp/wrss-p3-live-$file" >/dev/null
 "$adb" -s "$serial" shell run-as dev.podjs.runtime.test cp "/data/local/tmp/wrss-p3-live-$file" "files/syncv2-p3-live/$file"
 "$adb" -s "$serial" shell rm "/data/local/tmp/wrss-p3-live-$file"
done
"$adb" -s "$serial" shell am instrument -w -e class dev.podjs.runtime.P3LiveIntegrationTest dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner > "$evidence/instrumentation.log" 2>&1
"$adb" -s "$serial" exec-out run-as dev.podjs.runtime.test cat files/syncv2-p3-live/result.json > "$evidence/result.json"
python3 "$project/tests/sync-v2/emulator/live-p3-watermark.py" "$evidence/../author-watermark.json" "$evidence/result.json"
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test rm files/syncv2-p3-live/watch.json files/syncv2-p3-live/guest.js files/syncv2-p3-live/resume-watermark.json
rg -q '^OK \(1 test\)' "$evidence/instrumentation.log"
