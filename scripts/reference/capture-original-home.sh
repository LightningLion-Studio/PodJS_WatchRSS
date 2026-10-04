#!/usr/bin/env bash
set -euo pipefail
repo=/home/wilf/data/OPPO_Develop/Android_WatchRSS
source_dir=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/tests/reference
init_script=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/scripts/reference/inject-reference-test.gradle
artifact=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/artifacts/reference-profile.png
device=${ANDROID_SERIAL:-e3aca8af}

cd "$repo"
./gradlew -I "$init_script" :app:assembleDebug :app:assembleDebugAndroidTest --no-daemon \
  -PpodTestSourceDir="$source_dir"
app_apk=app/build/outputs/apk/debug/app-debug.apk
test_apk=app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
aapt_bin="${ANDROID_HOME:?}/build-tools/36.1.0/aapt"
app_id=$("$aapt_bin" dump badging "$app_apk" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")
test_id=$("$aapt_bin" dump badging "$test_apk" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")
[[ "$app_id" == com.lightningstudio.watchrss.reference ]] || { echo "refusing unexpected app id: $app_id" >&2; exit 1; }
[[ "$test_id" == com.lightningstudio.watchrss.reference.test ]] || { echo "refusing unexpected test id: $test_id" >&2; exit 1; }
adb -s "$device" install -r "$app_apk" >/dev/null
adb -s "$device" install -r "$test_apk" >/dev/null
adb -s "$device" shell am instrument -w -r -e class dev.podjs.androidwatch.OriginalHomeReferenceTest#captureOriginalProfileWindow \
  com.lightningstudio.watchrss.reference.test/androidx.test.runner.AndroidJUnitRunner
mkdir -p "$(dirname "$artifact")"
adb -s "$device" exec-out run-as com.lightningstudio.watchrss.reference \
  cat files/reference-profile.png > "$artifact"
file "$artifact"
