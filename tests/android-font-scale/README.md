# Isolated Activity font-scale runners

This directory adds test-APK-only runners. It does not modify the application,
SDK, namespace, build type, application ID, device font settings, or global
Resources. It requires an explicitly supplied instrumentation string argument
`fontScale=1.0`, `fontScale=1.3` or `fontScale=1.8`; omission and alternative
spellings fail. Explicit `1.0` applies the same Activity-local override and
global-state checks as the larger scales; it does not select or change the device
default.

| Runner class | Exact target ID | Exact test ID | Activities receiving the override |
| --- | --- | --- | --- |
| `dev.podjs.tests.fontscale.NativeFontScaleRunner` | `com.lightningstudio.watchrss.onboardingreference` | `com.lightningstudio.watchrss.onboardingreference.test` | `com.lightningstudio.watchrss.BeianActivity`, `com.lightningstudio.watchrss.InfoActivity` |
| `dev.podjs.tests.fontscale.PodFontScaleRunner` | `dev.podjs.tests.startup` | `dev.podjs.tests.startup.test` | `dev.podjs.androidwatch.MainActivity` |

The existing native `tests/native-onboarding/inject.gradle` and
`inject-info-restoration.gradle` both assign the native target/test IDs above in
`afterEvaluate`. The Pod SDK's `:androidApp` keeps namespace
`dev.podjs.androidwatch`; its existing `-PpodAppId=dev.podjs.tests.startup` selects
the isolated target. The runners intentionally do not import `BuildConfig`.

## Build integration

Append this file as the **last explicit `-I`** to the existing isolated build:

```text
-I /home/wilf/data/OPPO_Develop/PodJS_WatchRSS/tests/android-font-scale/inject-font-scale.gradle
```

Keep the existing native `-I inject.gradle` or `-I inject-info-restoration.gradle`
before this file. Keep all existing Pod startup init scripts and properties
before it as well. This file's own `afterEvaluate` reads the application ID after
the earlier isolation hooks, chooses the corresponding runner, and adds only
`java/` to `androidTest.java.srcDirs`. `projectsEvaluated` verifies that later
hooks did not replace the identity, runner, or sources. Any production application
ID fails configuration; the script never rewrites IDs to make a build pass.
Custom test IDs, product flavors and tested application ID suffixes also fail.

For a Gradle-managed instrumentation invocation, pass
`-Pandroid.testInstrumentationRunnerArguments.fontScale=1.0` (or `1.3` / `1.8`). For an
already authorized direct instrumentation invocation, the corresponding argument
is `-e fontScale 1.0` (or `1.3` / `1.8`) and the component is the exact test package plus
the runner class in the table. Preserve the existing test selection arguments.
Building an APK does not require `fontScale`; running the runner does.

After a build, verify the actual test APK manifest contains both the intended
runner class and exact target package. DSL selection alone is not APK evidence.
This directory's offline verifier does not build, install, launch or control a
device. Use the existing isolated build/output and device authorization workflow.

## Lifecycle and evidence

The runner calls `super.newActivity(ClassLoader, String, Intent)`, verifies the
actual allowed Activity class and `baseContext == null`, and immediately calls
`activity.applyOverrideConfiguration(delta)` after creating a fresh `Configuration`
and assigning only `delta.fontScale = requested`. There is no
late fallback. Other Activity classes receive no override. An allowlisted class
substitution or an allowlisted Activity bypassing this hook fails the run.

On API 30, `ActivityThread.performLaunchActivity` constructs the Activity before
`attach`; `attach` creates `PhoneWindow`, whose `Window` constructor reads Activity
resources, and themes are also applied before `callActivityOnCreate`. Therefore
the latter callback is too late to inject the override. API 30's
`ContextThemeWrapper.applyOverrideConfiguration` only copies the delta; it does
not access the unattached base or resources. Constructors of the current three
allowed Activities do not read resources. If this changes, an early cached
Resources object causes the API's own override rejection; no global workaround
is attempted.

Each new instance, including each recreation, receives its own override and
sequence number. Before `onCreate`, after `onCreate`, and in a posted next-main-loop
callback, the runner records and checks the actual Activity font scale and density.
Application, target and system Resources use copied `Configuration` and copied
`DisplayMetrics` baselines, compared using their platform `equals` methods. They
also freeze the Float bits returned by public `TypedValue.applyDimension` for
8/12/14/20/30/100 SP, so a newer API's hidden nonlinear converter cannot change
behavior unnoticed merely because the visible metrics compare equal.
The raw `Settings.System.FONT_SCALE` string is read only and compared. External
system changes fail these assertions; they are never silently treated as success.

JSON evidence is atomically replaced after each checkpoint in the isolated target's
`getExternalFilesDir("font-scale-runner")`, in
`font-scale-<scale>-<timestamp>-<pid>.json`. It includes full snapshot descriptions,
numeric font/density fields, actual Activity class, instance identity, override
success, phases, and failures. The instrumentation result supplies the absolute
path under the `fontScaleEvidence` key. `finished=true` and
`runnerAssertionsPassed=true` require at least one real allowed Activity and
complete lifecycle evidence for every overridden instance. They describe runner
assertions; they do not replace the test suite's result or visual acceptance.
Finish rechecks all global snapshots before delegating to AndroidJUnitRunner.

## Offline verification

```sh
python3 tests/android-font-scale/verify-offline.py
```

This uses local `javac --release 8` against the Android API 30 SDK jar and cached
AndroidX runner 1.7.0 / monitor 1.8.0 API jars, with cached annotation 1.3.0 and
compiler warnings treated as errors. A normal JVM runs the **same** pure
Java identity/font argument policy used by the real runner, covering all three
explicit scales, production IDs and crossed runner identities at each scale,
missing/invalid arguments and fake Activity names.
`javap` audits the compiled runner for its sole local override call and rejects
global mutation calls or premature Activity context/resource calls. These checks
do not emulate Android lifecycle behavior and cannot prove on-device rendering.

Optional paths: `--android-jar /absolute/path/android.jar` and
`--gradle-cache /absolute/path/caches`. Missing caches fail without downloads.
