#!/usr/bin/env bash
# Explicit isolated P3B account + owned emulator. Never print fixture contents.
set -euo pipefail
framework=$(realpath "${1:?framework required}")
serial=${2:?owned emulator required}
evidence=${3:?evidence required}
[[ $framework == /home/wilf/data/PodJS/podjs-watch.wt-syncv2-p3b ]]
[[ $serial =~ ^emulator-[0-9]+$ ]]
project=$(cd "$(dirname "$0")/../../.." && pwd)
[[ $(realpath "$project/node_modules/@podjs/framework") == "$framework/packages/framework" ]]
adb=${ANDROID_SDK_ROOT:-/home/wilf/Android/Sdk}/platform-tools/adb
[[ $("$adb" -s "$serial" emu avd name | tr -d '\r' | head -1) == WrssP3BWatchLive ]]
native="$framework/platforms/android/runtime/src/androidTest/java/dev/podjs/runtime/P3BLiveIntegrationTest.java"
[[ ! -e $native ]]
mkdir -p "$evidence"
evidence=$(realpath "$evidence")
exec 9>"$evidence/../p3b-live.lock"
flock -n 9
python3 "$project/tests/sync-v2/emulator/p3b-live-watermark.py" "$evidence/../author-watermark.json"
cp "$project/tests/sync-v2/emulator/P3BLiveIntegrationTest.java" "$native"
trap 'rm -f "$native"' EXIT
(cd "$project" && bun build tests/sync-v2/emulator/live-p3b-guest.ts --target=browser --format=iife --outfile="$evidence/guest.js")
(cd "$framework/platforms/android" && ./gradlew :runtime:assembleDebugAndroidTest --max-workers=2 -PpodAbis=x86_64 --offline) > "$evidence/build.log" 2>&1
"$adb" -s "$serial" reverse tcp:18952 tcp:18952
"$adb" -s "$serial" install -r "$framework/platforms/android/runtime/build/outputs/apk/androidTest/debug/runtime-debug-androidTest.apk"
"$adb" -s "$serial" shell run-as dev.podjs.runtime.test mkdir -p files/syncv2-p3b-live
cleanup(){
 rm -f "$native"
 "$adb" -s "$serial" shell run-as dev.podjs.runtime.test rm -f files/syncv2-p3b-live/watch.json files/syncv2-p3b-live/guest.js files/syncv2-p3b-live/resume-watermark.json >/dev/null
}
trap cleanup EXIT
for file in watch.json guest.js resume-watermark.json; do
 source="$evidence/guest.js"
 if [[ $file == watch.json ]]; then source=/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/integration-p3b/watch.json; fi
 if [[ $file == resume-watermark.json ]]; then source="$evidence/../author-watermark.json"; fi
 "$adb" -s "$serial" push "$source" "/data/local/tmp/wrss-p3b-live-$file" >/dev/null
 "$adb" -s "$serial" shell run-as dev.podjs.runtime.test cp "/data/local/tmp/wrss-p3b-live-$file" "files/syncv2-p3b-live/$file"
 "$adb" -s "$serial" shell rm "/data/local/tmp/wrss-p3b-live-$file"
done
"$adb" -s "$serial" shell am instrument -w -e class dev.podjs.runtime.P3BLiveIntegrationTest dev.podjs.runtime.test/androidx.test.runner.AndroidJUnitRunner > "$evidence/instrumentation.log" 2>&1
"$adb" -s "$serial" exec-out run-as dev.podjs.runtime.test cat files/syncv2-p3b-live/result.json > "$evidence/result.json"
python3 "$project/tests/sync-v2/emulator/p3b-live-watermark.py" "$evidence/../author-watermark.json" "$evidence/result.json"
rg -q '^OK \(1 test\)' "$evidence/instrumentation.log"
