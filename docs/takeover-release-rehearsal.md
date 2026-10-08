# Non-debuggable platform-metadata rehearsal

Use a dedicated app/framework checkout and only `com.lightningstudio.watchrss.podjs.rehearsal` on `e3aca8af`. The fixture refuses any other package, a debuggable target, or an existing native database/journal. It writes synthetic data inside the non-debuggable target using same-signature instrumentation, without using run-as or reading another package. The fixture class is packaged only in `.rehearsal.test`.

Prepare the isolated app configuration with the rehearsal applicationId, remove native signing and debugExternal configuration, and set the WorkManager nativeAppId to the rehearsal package. Install dependencies with all local framework/PocketJS paths verified as source symlinks. Run the CLI build before packaging to generate styles and assets. Build the Android runtime for the watch ABI.

With `T15_FRAMEWORK`, `T15_APP`, and `T15_DIST` set to those isolated paths and generated android-watch assets:

```bash
ANDROID_SDK_ROOT=/home/wilf/Android/Sdk \
JAVA_HOME=/usr/lib/jvm/java-21-openjdk \
"$T15_FRAMEWORK/platforms/android/gradlew" -p "$T15_FRAMEWORK/platforms/android" --offline \
  :androidApp:assembleRelease :androidApp:assembleReleaseAndroidTest \
  -PpodAppId=com.lightningstudio.watchrss.podjs.rehearsal \
  -PpodVersionCode=1501 -PpodVersionName=T15 \
  -PpodAbis=armeabi-v7a -PpodReleaseDebuggable=false \
  -PpodDistDir="$T15_DIST" -PpodResDir="$T15_APP/android/res" \
  -PpodAppTheme=@style/Theme.WatchRSS.PodJS.Splash \
  -PpodTakeoverSourceVersionCode=40 -PpodCleartextTraffic=true \
  -PpodTestSourceDir="$T15_APP/tests/android/release-rehearsal" \
  -I "$T15_APP/scripts/migration/release-rehearsal.init.gradle"
```

The init script rejects any other applicationId, uses only the Android debug signing configuration, and sets the tested build type to release. Inspect both actual APK manifests and matching certificates before installation; release debuggable must be absent/false, instrumentation targetPackage must be the isolated app, and ProfileInstallerInitializer/WorkManagerInitializer must be absent from startup metadata. Confirm release baseline profile assets are present.

After the device owner is released, acquire `DEVICE_OWNER=wrss-impl`, install only these two APKs and run:

```bash
adb -s e3aca8af shell am instrument -w -r \
  -e class dev.podjs.runtime.ReleaseTakeoverMetadataTest \
  com.lightningstudio.watchrss.podjs.rehearsal.test/androidx.test.runner.AndroidJUnitRunner
```

The test seeds a migrated Room v18 layout with real native ALTER defaults, business rows/body, identity preferences, no_backup data and both ProfileInstaller markers. It waits beyond the old initializer delay, seeds two synthetic partial candidates plus a legacy PAUSED/stage_failed/DETECTED journal, then starts the production MainActivity. It verifies ACTIVE, retention of both candidates, converted content consumption, marker exclusion from business files, and exact fixture-root equality in the sealed backup. Finally it requires the real skip marker to contain the package's lastUpdateTime after ProfileInstaller runs, and confirms the original marker is still intact in the backup.

Capture only this target PID's digest/ProfileInstaller/test logs. The pre fixture projection uses `T15RehearsalPre`, not the production digest tag; it is synthetic instrumentation evidence, not a debug-source pre receipt. Uninstall only the rehearsal app/test afterwards and restore `DEVICE_OWNER=released`. This does not authorize formal/native/.podjs package operations.
