# Non-debuggable takeover classification rehearsal

Use a dedicated app/framework worktree and only `com.lightningstudio.watchrss.podjs.rehearsal` on `e3aca8af`. The fixture refuses every other package, a debuggable target, or an existing native database/journal. It writes synthetic data inside the non-debuggable target using same-signature instrumentation. Its class is packaged only in `.rehearsal.test`.

In an isolated app config, use the rehearsal applicationId, remove native signing/debugExternal configuration, set WorkManager nativeAppId to the rehearsal package, and set versionCode 1701. Verify local dependencies are source symlinks to the isolated framework and its exact PocketJS revision. Run the CLI build before packaging. Restore the ordinary app configuration after building assets; neither signing properties nor formal data are needed. T17 uses unchanged native runtime bytes from the exact T15 source/PocketJS revision; changes are Java-only.

With `T17_FRAMEWORK`, `T17_APP`, and `T17_DIST` set to the isolated paths and generated rehearsal android-watch assets:

```bash
ANDROID_SDK_ROOT=/home/wilf/Android/Sdk \
JAVA_HOME=/usr/lib/jvm/java-21-openjdk \
"$T17_FRAMEWORK/platforms/android/gradlew" -p "$T17_FRAMEWORK/platforms/android" --offline \
  :androidApp:assembleRelease :androidApp:assembleReleaseAndroidTest \
  :runtime:testDebugUnitTest \
  -PpodAppId=com.lightningstudio.watchrss.podjs.rehearsal \
  -PpodVersionCode=1701 -PpodVersionName=T17 \
  -PpodAbis=armeabi-v7a -PpodReleaseDebuggable=false \
  -PpodDistDir="$T17_DIST" -PpodResDir="$T17_APP/android/res" \
  -PpodAppTheme=@style/Theme.WatchRSS.PodJS.Splash \
  -PpodTakeoverSourceVersionCode=40 -PpodCleartextTraffic=true \
  -PpodTestSourceDir="$T17_APP/tests/android/release-rehearsal" \
  -I "$T17_APP/scripts/migration/release-rehearsal.init.gradle"
```

The init script rejects other applicationIds, uses only Android debug signing, and tests the release build type. Inspect both APK manifests and matching certificates before installation. Release debuggable must be absent/false; instrumentation targetPackage must be the isolated app; ProfileInstallerInitializer/WorkManagerInitializer must be absent from startup metadata. Require release baseline profile assets and absence of the fixture class from release DEX.

After verifying DEVICE_OWNER is released, acquire it as wrss-impl, check for existing rehearsal packages, install only these two inspected APKs, and run:

```bash
adb -s e3aca8af shell am instrument -w -r \
  -e class dev.podjs.runtime.ReleaseTakeoverMetadataTest \
  com.lightningstudio.watchrss.podjs.rehearsal.test/androidx.test.runner.AndroidJUnitRunner
```

The fixture seeds a historical migrated Room v18 layout, body/identity/no_backup data, both ProfileInstaller markers, offline RSS/Bili, reader and note assets, a private test protobuf, native log, exact AndroidX locale/history filenames, and 17 cache files. Cache includes Coil default and explicit RSS cache, generic/Room/Typeface/NanoHTTPD/Guava/provider temporary shapes, named media/TTS/update caches and an exact database lock. Nine cache paths are outside the legacy named-cache shapes.

It waits beyond the old initializer delay, seeds three retained synthetic candidates plus a legacy `BLOCKED/unknown_user_files` journal and a files-3 report containing only that blocker, then starts production MainActivity. It requires a fresh files-4 generation at ACTIVE; all three candidates unchanged; zero unknown files, nine unrecognized caches and one exact database lock; consumed body/SQLite content; no imported cache/private platform state; and exact pre/SNAPSHOTTED/ACTIVE native backup root equality. It then requires a real post-admission ProfileInstaller marker matching PackageInfo.lastUpdateTime and confirms the old marker is intact in sealed backup. This is synthetic isolated evidence, not formal sandbox equality or an exact diagnosis of formal v1002's unknown file.

Capture logs for this target PID only, including `T17RehearsalPre`, `T17Rehearsal`, `PodTakeoverDigest`, `PodTakeoverFiles`, and `ProfileInstaller`. Uninstall only the rehearsal app/test, verify cleanup, and restore DEVICE_OWNER to released. This does not authorize formal/native/.podjs package operations.
