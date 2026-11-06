#!/usr/bin/env bash
# Build only. No adb, native/formal installation, keystore-properties load, or signing secrets.
set -euo pipefail
app=$(cd "$(dirname "$0")/../.." && pwd)
framework=${PODJS_FRAMEWORK_SOURCE:-$(bun "$app/scripts/framework-path.ts")}
native=${WATCHRSS_RECOVERY_SOURCE:-/home/wilf/data/OPPO_Develop/Android_WatchRSS.wt-recovery}
package=com.lightningstudio.watchrss.podjs.rehearsal
bun "$framework/packages/cli/src/cli.ts" build --target=android-watch --project="$app"
(cd "$framework" && bash scripts/build-android-runtime.sh)
(cd "$framework/platforms/android" && ./gradlew :androidApp:assembleDebug --offline --no-daemon \
  -PpodAppId="$package" -PpodAppName=WatchRSSRecoveryRehearsal \
  -PpodVersionCode=1000 -PpodTakeoverSourceVersionCode=40 -PpodCleartextTraffic=true \
  -PpodDistDir="$framework/dist/projects/com.lightningstudio.watchrss.podjs/android-watch" \
  -PpodResDir="$app/android/res" -PpodAppTheme=@style/Theme.WatchRSS.PodJS.Splash)
(cd "$native" && ./gradlew :app:testDebugUnitTest :app:assembleDebug --offline --no-daemon \
  -PrecoveryRehearsal=true -PrecoveryVersionCode=900000)
printf '%s\n' 'Built isolated takeover code1000 and native recovery code900000; installation/Keystore/native functionality PENDING.'
