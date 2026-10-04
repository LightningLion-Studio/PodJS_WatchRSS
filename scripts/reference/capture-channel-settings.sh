#!/usr/bin/env bash
set -euo pipefail
app_root="$(cd "$(dirname "$0")/../.." && pwd)"
native_root="$(cd "$app_root/../Android_WatchRSS" && pwd)"
device="${ANDROID_SERIAL:-e3aca8af}"
sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Android/Sdk}}"
cd "$native_root"
./gradlew -I "$app_root/scripts/reference/inject-reference-test.gradle" \
  :app:assembleRelease :app:assembleReleaseAndroidTest --no-daemon \
  -PpodTestSourceDir="$app_root/tests/reference" -PpodReferenceBuildType=release
app_apk=app/build/outputs/apk/release/app-release.apk
test_apk=app/build/outputs/apk/androidTest/release/app-release-androidTest.apk
app_id=$("$sdk_root/build-tools/36.1.0/aapt" dump badging "$app_apk" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")
test_id=$("$sdk_root/build-tools/36.1.0/aapt" dump badging "$test_apk" | sed -n "s/^package: name='\([^']*\)'.*/\1/p")
[[ "$app_id" == com.lightningstudio.watchrss.reference && "$test_id" == com.lightningstudio.watchrss.reference.test ]] || { echo "Unexpected reference package ids" >&2; exit 1; }
adb -s "$device" install -r "$app_apk"
adb -s "$device" install -r "$test_apk"
adb -s "$device" shell am instrument -w -r -e class 'dev.podjs.androidwatch.reference.RssActionsReferenceTest#captureChannelSettings,dev.podjs.androidwatch.reference.RssActionsReferenceTest#captureLocalChannelSettings,dev.podjs.androidwatch.reference.RssActionsReferenceTest#captureMediaChannelSettings,dev.podjs.androidwatch.reference.RssActionsReferenceTest#captureDeleteChannelConfirm,dev.podjs.androidwatch.reference.RssActionsReferenceTest#captureClearChannelConfirm' \
  com.lightningstudio.watchrss.reference.test/androidx.test.runner.AndroidJUnitRunner
for name in channel-settings local-channel-settings media-channel-settings delete-channel-confirm clear-channel-confirm; do
  adb -s "$device" exec-out cat "/sdcard/Android/data/com.lightningstudio.watchrss.reference/files/reference-$name.png" > "$app_root/artifacts/reference-$name.png"
done
