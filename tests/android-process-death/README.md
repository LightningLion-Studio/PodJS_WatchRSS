# Isolated Android process-death harness

This harness adds an Application to the existing startup verification APK. It uses the SDK's unchanged `dev.podjs.androidwatch.MainActivity` and the production guest startup flow. It is intended to collect Android saved-instance-state evidence across actual process death, without an instrumentation runner sharing the process that will be killed.

The package is **only** `dev.podjs.tests.startup`. Its Android namespace remains `dev.podjs.androidwatch`; the Application class is `dev.podjs.tests.processdeath.ProcessDeathApplication`. These three identifiers intentionally differ. The production WatchRSS package must never receive this Application, configuration, commands, or test seed data.

## Dedicated build

The init script is opt-in and accepts only `:androidApp:assembleDebug`. It refuses another application ID, a non-debug test build type, product flavors, an application ID suffix, or a non-debuggable debug build. It checks the final variant's package identity before executing tasks. Install, connected-device, instrumentation, unit-test, and release tasks are rejected.

Use a new absolute build directory whose final component begins `watchrss-process-death-` and includes a run identifier. It must be outside both the SDK and WatchRSS repositories. All project build directories, the runtime CMake staging directory, and the project cache are placed beneath it; existing child symlinks that escape it are rejected. Supply the correct project-cache path on the initial command, since Gradle may initialize its cache before an init script can reject a wrong path.

The following is a template, not a recorded successful build. Set `STARTUP_DIST` to the freshly built and validated startup fixture assets; choose the run identifier and device ABI before use.

```sh
SDK_ANDROID=/home/wilf/data/PodJS/podjs-watch/platforms/android
HARNESS_ROOT=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/tests/android-process-death
PROCESS_DEATH_BUILD=/tmp/watchrss-process-death-REPLACE_RUN_ID
STARTUP_DIST=/absolute/path/to/validated/startup/android-watch

"$SDK_ANDROID/gradlew" -p "$SDK_ANDROID" \
  --no-configuration-cache \
  --project-cache-dir "$PROCESS_DEATH_BUILD/gradle-cache" \
  --init-script "$HARNESS_ROOT/inject-process-death.gradle" \
  -PwatchRssProcessDeathHarness=true \
  "-PwatchRssProcessDeathBuildDir=$PROCESS_DEATH_BUILD" \
  -PpodAppId=dev.podjs.tests.startup \
  -PpodAppName='Startup Process Death Verification' \
  "-PpodDistDir=$STARTUP_DIST" \
  -PpodAbis=REPLACE_DEVICE_ABI \
  :androidApp:assembleDebug
```

APK output metadata is under `PROCESS_DEATH_BUILD/projects/androidApp/outputs/apk/debug`. Before installation, inspect the actual APK's application ID, debuggable flag, Application name, and launcher component, and record its SHA-256. The launcher must remain `dev.podjs.androidwatch.MainActivity`.

`target/AndroidManifest.xml` replaces only this build's debug manifest source. It adds the Application and preserves the SDK debug cleartext-traffic setting for local fixtures. It does not redeclare or replace MainActivity. The SDK main manifest still supplies the Activity. No SDK manifest, existing startup init script, or production source set is edited.

## Private-file protocol

All protocol artifacts belong to the isolated target package's `files/process-death/` directory. A run uses a fresh 32-character lowercase hexadecimal `runNonce`.

Before launch, the host writes `config.json` with exactly:

```json
{"version":1,"packageName":"dev.podjs.tests.startup","runNonce":"0123456789abcdef0123456789abcdef"}
```

The example nonce must be replaced for a real run. Seed any required startup KV state through the isolated package's own files before launch; there is no seed command. Do not overwrite production KV, consent records, or another run's fixture data.

The Application records its process identity in `lifecycle.jsonl`. After reading that identity, the host writes a complete `command.tmp` and atomically renames it to `command.json`. Every command contains only these common fields:

- `version`: `1`.
- `runNonce`: the configured run nonce.
- `id`: a fresh 32-character lowercase hexadecimal command ID.
- `pid`: the current process's positive integer PID.
- `processInstance`: the current process's 32-character lowercase hexadecimal instance ID.
- `op`: `snapshot`, `action`, or `background`.

An `action` command additionally supplies `snapshotToken`, `nodeId`, and `action`. The token is the 32-character lowercase hexadecimal token returned by a current snapshot; `nodeId` is a positive integer; `action` is one of `1`, `2`, or `4`. Unknown fields are rejected. These are semantic actions on the currently observed guest tree, not injected touch, key, rotary, or focus events.

The Application claims a command by renaming it to `inflight.json`, publishes `claims/<id>.json` before any effect, and writes `acks/<id>.json` once. Claims and acknowledgements are written and synced in a temporary file before an atomic rename makes the final JSON visible. Only the package's default process and its main thread produce receipts. A duplicate command ID never executes again. A claim left pending by a crash produces an interrupted acknowledgement rather than replaying its effect. A failed terminal publication preserves the inflight recovery record; an existing malformed terminal receipt fails closed. Commands bind both the run and current process; a command prepared before death cannot control the replacement process.

Snapshot acknowledgement values contain `tree`, `snapshotToken`, `hostState`, and `persistentKv = {exists, sha256, bytes}`. The host-state snapshot includes the saved and retained JSON strings. A background acknowledgement records `moved`, host state, and the same persistent-KV observation. Backgrounding is separate from killing: the protocol has no kill operation.

An action acknowledgement with `accepted` only proves that the semantic action was queued for guest delivery. It does not prove that the guest consumed it or completed the interaction. Obtain a subsequent snapshot and verify the expected guest tree and host state. Reading host state does not flush pending JavaScript work; the last snapshot before backgrounding must already show the expected custom draft and values.

`probe.py` is the host-side offline command generator and proof checker. It does not execute ADB. Keep its generated commands and proof inputs with the device receipt; its result is bounded by the raw evidence provided to it.

These examples operate on already collected local files. Generate commands one at a time from the latest lifecycle journal; submit each generated JSON through the private `command.tmp` → `command.json` protocol and collect its acknowledgement before the next dependent step. Replace paths and the action label before use.

```sh
PROBE_EVIDENCE=/absolute/path/to/owned-run-evidence
python3 "$HARNESS_ROOT/probe.py" config > "$PROBE_EVIDENCE/config.json"
python3 "$HARNESS_ROOT/probe.py" command \
  --events "$PROBE_EVIDENCE/lifecycle.jsonl" --op snapshot \
  > "$PROBE_EVIDENCE/snapshot-command.json"
python3 "$HARNESS_ROOT/probe.py" action \
  --events "$PROBE_EVIDENCE/lifecycle.jsonl" \
  --snapshot "$PROBE_EVIDENCE/current-snapshot-ack.json" \
  --label 'EXACT_CURRENT_LABEL' --action 1 \
  > "$PROBE_EVIDENCE/action-command.json"
python3 "$HARNESS_ROOT/probe.py" command \
  --events "$PROBE_EVIDENCE/lifecycle.jsonl" --op background \
  > "$PROBE_EVIDENCE/background-command.json"
```

After guest-state checks, backgrounding, lifecycle collection, and a scoped system dump, check the pre-kill barrier:

```sh
python3 "$HARNESS_ROOT/probe.py" barrier \
  --events "$PROBE_EVIDENCE/lifecycle.jsonl" \
  --background-ack "$PROBE_EVIDENCE/background-ack.json" \
  --before-dump "$PROBE_EVIDENCE/before-dump.txt" \
  --expected-kv "$PROBE_EVIDENCE/expected-kv.json"
```

`expected-kv.json` is the independently recorded `{exists, sha256, bytes}` baseline. A successful barrier result does not prove process death. After external process termination and restoration, validate the expanded evidence:

```sh
python3 "$HARNESS_ROOT/probe.py" validate \
  --events "$PROBE_EVIDENCE/lifecycle.jsonl" \
  --background-ack "$PROBE_EVIDENCE/background-ack.json" \
  --before-snapshot "$PROBE_EVIDENCE/before-snapshot-ack.json" \
  --after-snapshot "$PROBE_EVIDENCE/after-snapshot-ack.json" \
  --before-dump "$PROBE_EVIDENCE/before-dump.txt" \
  --dead-dump "$PROBE_EVIDENCE/dead-dump.txt" \
  --recovered-dump "$PROBE_EVIDENCE/recovered-dump.txt" \
  --expected-kv "$PROBE_EVIDENCE/expected-kv.json"
```

## Required evidence

The lifecycle trace includes `preCreate`, `postCreate`, `postSave`, `postStop`, and `postResume`. Each process must be attributable by PID and process-instance ID, and each Activity by task identity. `preCreate` and `postSave` include the raw Android Bundle observation:

```text
bundle = {present, savedKeyPresent, savedJson, savedUtf8Bytes, savedSha256}
```

`savedJson` and `savedSha256` can be null when no corresponding saved value exists. `preCreate` also records `lastNonConfigurationPresent`. `postCreate` records `hostState = {savedJson, retainedJson}` and `hostBooted`; `hostBooted` must be false when this observation is used as evidence from before the first guest execution.

A valid process-death comparison requires the old process to reach the relevant save/stop callbacks, an independently confirmed process termination, a different replacement process instance, and the same intended task restoration route. On Android 30, the relevant order is `postStop` → `postSave` → the framework's `StopInfo` Binder report. The Application callback alone is not proof that the system server has received the saved Bundle. Before killing, the host must collect a dumpsys observation scoped to this package and the target task that confirms the system-side saved Bundle is present. Do not kill based only on `postStop`, `postSave`, or the background acknowledgement.

Match the OS Bundle observation to the saved channel delivered to the new host. Check the retained channel separately: Activity recreation and process death have different retained-state behavior. Compare persistent KV digests before and after every recovery step, and inspect the restored guest tree and pending interactions. Do not start or stop instrumentation against the target during this protocol, and do not use force-stop as the process-death operation: either can disturb the task and state being measured.

An Activity `recreate`, a changed PID alone, an acknowledgement alone, or an offline proof checker passing does not establish the whole recovery behavior. Keep raw lifecycle records, commands, claims, acknowledgements, APK hashes, and host-side process observations with the receipt. Physical interaction and visual parity remain separate acceptance items.

## External coordinator phases

The offline CLI never executes these operations. The root coordinator owns installation, private-file transfer, process termination, and the following system observations. Use an explicit device serial and Android user. Take a fresh snapshot after each acknowledged action and wait for the expected tree/state before generating the next action; the snapshot token is consumed by one action. The control window is 20 minutes and at most 256 commands per process.

1. Launch the isolated MainActivity normally after installing the configuration and fixture KV. Do not run target instrumentation. Record the first process identity, original task ID, and exact system ActivityRecord identity.
2. Exercise production StartupGate using live semantic actions: advance to the agreement page, check the agreement, enter customization, change at least one demonstration value, and scroll the customization list away from its top. Retained state must show page 2; saved state must contain the checked agreement, nondefault customization, and nonzero scroll offset. Record a snapshot and the independently pulled KV digest.
3. Submit `background`. Collect the acknowledgement and lifecycle journal. Read only the exact target Activity with `dumpsys activity -a dev.podjs.tests.startup/dev.podjs.androidwatch.MainActivity`. Require the original record to show `state=STOPPED`, `stopped=true`, `finishing=false`, `mHaveState=true`, and non-null `mIcicle=Bundle[...]`, then run `probe.py barrier`.
4. Only after that barrier, the coordinator may use `am kill --user USER dev.podjs.tests.startup`. Command success is not death evidence: confirm the old PID is absent and the same scoped Activity/task record is present with `pid=(not running)` and its saved Bundle intact. If the process is not killable in its current importance state, stop and diagnose that condition; do not substitute force-stop or alter global settings. A separately reviewed `run-as` signal must revalidate ownership immediately before targeting any PID.
5. Restore the captured task with a normal Activity launch, preserving the component and launcher intent while requesting reuse:

   ```text
   am start -W --user USER --task CAPTURED_TASK_ID --activity-reorder-to-front \
     -a android.intent.action.MAIN -c android.intent.category.LAUNCHER \
     -n dev.podjs.tests.startup/dev.podjs.androidwatch.MainActivity
   ```

   Do not use `-S`, `CLEAR_TASK`, `CLEAR_TOP`, task-focus, or input-injection commands. `--task` alone can create another Activity when the new intent differs; `REORDER_TO_FRONT` also creates one if the original record has disappeared. Therefore the final validator still requires the exact original system ActivityRecord identity and task ID, rather than trusting launch flags.
6. Collect the new lifecycle journal, a new-process snapshot, and the scoped resumed dump. Run `probe.py validate`. It checks the incoming system Bundle against the old postSave value and inspects saved/retained channels before guest boot. Then separately check the production UI: the welcome page returns because retained page 2 was lost; advancing to agreement keeps its checked state, and reentering customization consumes the saved demonstration values and scroll offset. Preserve those additional snapshots and compare KV after each step. The generic boundary receipt deliberately keeps `uiParityVerified=false`.

This proves restoration after an externally terminated process; it does not claim that actual low-memory pressure caused the termination. If the OEM removes the task/record, suppresses the state callbacks, refuses backgrounding, or cannot expose the required scoped state, the evidence is incomplete. Do not replace it with a manually supplied Bundle or clear-retained simulation.

## Optional stepwise device coordinator

`run_device.py` executes ADB; unlike `probe.py`, it is **not** an offline-only tool. It has no install, run-all, instrumentation, input, wake, focus, force-stop, reset, or cleanup operation. Each invocation performs one requested phase and records its raw evidence. Review a phase's result before selecting the next phase. Python 3.11 or newer and a working `adb` executable are required.

Supply an explicit serial, numeric current Android user, fresh output directory, and an ownership receipt for the APKs actually installed for this run. The receipt must contain exactly the isolated target and test package SHA-256 values under `packages`, and both formal application hashes under `formalBefore`:

```json
{
  "packages": {
    "dev.podjs.tests.startup": "64_LOWERCASE_HEX_CHARACTERS",
    "dev.podjs.tests.startup.test": "64_LOWERCASE_HEX_CHARACTERS"
  },
  "formalBefore": {
    "com.lightningstudio.watchrss.podjs": "64_LOWERCASE_HEX_CHARACTERS",
    "com.lightningstudio.watchrss": "64_LOWERCASE_HEX_CHARACTERS"
  }
}
```

A receipt with that object nested under `current` is also accepted. A formal hash may include the original `sha256sum` output's two spaces and `/data/app/.../base.apk` path. Old `mainBefore`-only receipts are rejected. The coordinator reads all four currently installed APK hashes before **every** mutation, including snapshots, and refuses any difference. It supports one base APK per package and the API 30 system-dump format used by this proof. It verifies the current user and run-as app UID and rejects target instrumentation using the package-scoped ActivityManager process dump.

Set these values for a reviewed run; do not reuse an earlier receipt after installing a different target APK:

```sh
PROCESS_DEATH_SERIAL=REPLACE_EXPLICIT_ADB_SERIAL
PROCESS_DEATH_USER=0
PROCESS_DEATH_RECEIPT=/absolute/path/to/current-owned-packages.json
PROCESS_DEATH_OUT=/absolute/path/to/a-new-process-death-run
HARNESS_ROOT=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/tests/android-process-death

process_death_step() {
  python3 "$HARNESS_ROOT/run_device.py" \
    --serial "$PROCESS_DEATH_SERIAL" --user "$PROCESS_DEATH_USER" \
    --receipt "$PROCESS_DEATH_RECEIPT" --out "$PROCESS_DEATH_OUT" "$@"
}
```

Use the following commands individually:

| Command | Effect and evidence |
| --- | --- |
| `process_death_step prepare` | Requires no target/test process and no existing controller directory. Backs up the whole run-as app-data directory to a local tar, verifies its KV against a fresh read, saves the original KV bytes/existence/hash, then atomically publishes a run-specific startup seed and configuration. No backup is automatically extracted. |
| `process_death_step start` | Requires no target/test process and no old target Activity record. Launches only the fixed MainActivity and records its fresh process, original task, and ActivityRecord. |
| `process_death_step snapshot` | Collects a current semantic tree, host state, token, lifecycle journal, and independent KV read. It invokes the harness snapshot command and can advance a native frame. |
| `process_death_step action --label 'EXACT_CURRENT_LABEL' --action 1` | Takes a fresh snapshot, resolves one uniquely labelled live node or supporting ancestor, submits exactly one semantic action, and captures another snapshot. Actions `2` and `4` are the other supported semantic masks. Acceptance alone does not prove the desired guest effect; inspect the returned snapshot before another action. |
| `process_death_step background` | Takes the before snapshot and requires the checked agreement, a nondefault customization value, nonzero saved scroll, and retained customization page 2 before requesting `moveTaskToBack(true)`. |
| `process_death_step barrier` | Reads fresh lifecycle, process/UID, KV, and scoped system state. Requires the original live Activity to be stopped with its saved Bundle held by the system server. |
| `process_death_step kill` | Requires a completed, separately selected barrier phase, then rechecks that barrier and all package hashes. Sends only `am kill --user USER dev.podjs.tests.startup` once. Success requires the old PID to disappear from the full process table, no target/test process, and the original system record to retain its Bundle while explicitly not running. |
| `process_death_step restore` | Rechecks death and KV, launches the captured task with `--activity-reorder-to-front`, and verifies the actual incoming system Bundle and pre-guest saved/retained observations before allowing a new snapshot. |
| `process_death_step validate` | Captures an after snapshot, runs the shared offline boundary validator, and saves its result. `uiParityVerified` remains false; separately inspect welcome, checked agreement, and restored customization/scroll through further chosen snapshot/action steps. |
| `process_death_step collect` | Reads diagnosis artifacts, including controller claims/acks, without submitting any command or changing the recorded phase. This is the only permitted operation after an unresolved mutation. |

`prepare` seeds `watchrss.onboarding` with both committed versions at zero, an unknown-field sentinel containing the run nonce, a zero content-mount count, and unrelated preserved fixture data. It replaces only the isolated target's KV after preserving its prior data. The run's `expected-kv.json` records the exact seeded bytes' digest; all subsequent steps require it to remain unchanged. Do not complete onboarding during this draft-restoration probe, since committing it intentionally changes KV.

Output includes `run.json`, the immutable supplied receipt, original/seed KV, configuration, expected KV, the app-data archive, and one directory per invocation. Each ADB call records its explicit argv, UTC time, input digest, stdout/stderr and result; commands, claims, acknowledgements, lifecycle snapshots and parsed proof artifacts receive SHA-256 sidecars. Shell payloads are passed as stdin bytes through non-PTY ADB; JSON is never interpolated into shell code. Both an output lock and a device/user/package lock prevent simultaneous coordinator invocations from racing across different output directories.

A mutation intent is persisted before execution. Its validated result, phase, and cleared intent are committed together. An ADB timeout or failed proof leaves an unresolved intent and blocks further mutations. Durable `error`/`interrupted` receipts are saved immediately and reported as a terminal failure with an unverified effect, rather than automatically retried. `collect` preserves that state for review; there is intentionally no reset/replay operation or fallback signal. If `am kill` does not terminate the process, investigate the collected evidence rather than escalating to force-stop.

## Verification status

This directory is test scaffolding. The init script has a separate offline Groovy compilation check and the manifest can be parsed without building an APK. Neither establishes Gradle/manifest-merger compatibility or a successful device process-death run. Record those outcomes only after the corresponding build and device evidence exists.

The coordinator's unit tests use fake transports and block real subprocess execution. They do not establish that ADB transport, OEM dumpsys output, or process termination works on a device:

```sh
python3 -m unittest discover -s tests/android-process-death -p 'test_*.py' -v
```

## Legal v2 held-response scenario

The default scenario remains `custom`, including its checked-agreement, page-2,
nondefault-control and nonzero-scroll requirements. New runs can explicitly select
`--scenario legal`. The selection, exact loopback URL, independent server manifest
and fixture body digest are recorded during `prepare`; another invocation cannot
change them. An older run without scenario metadata remains a custom run.

This scenario uses the production StartupGate and the same unmodified Application
and MainActivity. Build the process-death APK with fresh `runtime-startup` assets
containing legal v2. Do not launch instrumentation. The seed selects the privacy
version gate (`oobeSeenVersion=3`, `privacyPolicyAgreedVersion=0`) and supplies
`startup-legal-base-url`. It explicitly disables `legal-restoration-events` and
keeps the existing whole-KV byte/hash baseline. Do not agree to or finish consent:
those real actions intentionally change persistent data.

Start `legal_server.py` in a separate host process. It binds only `127.0.0.1` on a
random port, writes an immutable `manifest.json` and run-specific `body.utf8`, and
records protocol requests in `state.json`. Its lifetime must span the Android process
termination. The first exact privacy request completes immediately; request 2 is
held until an authenticated local release marker arrives, for at most 10 seconds.
A timeout, unexpected method, another path, or a third protocol request records
failure; it never silently turns a timeout into a successful fixture response.
The sole exception is exact `GET /`: it returns an empty 404 after durably recording
the peer address/port, method, path and receive time in `root-probes.json`. These
entries have their own sequence, do not change protocol state, and never release
request 2 or return fixture content. `HEAD /`, `GET /?query` and every other path
remain failures. The audit is bounded at 256 entries; missing, invalid or
unwritable audit evidence fails closed. Preserve this separate audit with the
server evidence. It records probe receipt, not successful response delivery.

The root operator owns the server process and ADB reverse mapping. These are
templates, not recorded device results:

```sh
LEGAL_SERVER_OUT=/absolute/path/to/new-legal-server-evidence
LEGAL_NONCE=REPLACE_WITH_FRESH_32_LOWERCASE_HEX_CHARACTERS
python3 -B "$HARNESS_ROOT/legal_server.py" \
  --out "$LEGAL_SERVER_OUT" --nonce "$LEGAL_NONCE"
```

In the coordinating terminal, read the actual host port from the manifest,
choose an unused device port and establish only the owned mapping:

```sh
adb -s "$PROCESS_DEATH_SERIAL" reverse --no-rebind \
  tcp:REPLACE_DEVICE_PORT tcp:REPLACE_MANIFEST_HOST_PORT

legal_death_step() {
  python3 -B "$HARNESS_ROOT/run_device.py" \
    --serial "$PROCESS_DEATH_SERIAL" --user "$PROCESS_DEATH_USER" \
    --receipt "$PROCESS_DEATH_RECEIPT" --out "$PROCESS_DEATH_OUT" \
    --scenario legal --legal-base-url http://127.0.0.1:REPLACE_DEVICE_PORT \
    --legal-server "$LEGAL_SERVER_OUT" "$@"
}
```

The exact URL must remain unchanged across death, including host and device port:
it is part of the v2 body identity. Existing `prepare` restrictions still apply,
including a new output directory, no target/test process and no old controller
directory. Preserve earlier fixture evidence before arranging these conditions;
there is no automatic cleanup, data reset or run-nonce reuse.

Execute and inspect these phases individually:

1. `legal_death_step prepare`, then `legal_death_step start`.
2. Inspect `snapshot`; activate the live `查看《隐私政策》` label with `action --label
   '查看《隐私政策》' --action 1`. Wait for request 1 and visible fixture content.
3. Run `legal_death_step legal-baseline`. It records two stable canonical-top
   observations and verifies the complete referenced body bytes independently.
4. Scroll using `action --label '协议正文' --action 2`, inspect the returned state,
   and repeat if needed. Require a nonzero canonical list anchor and geometry
   different from the initial top. This invokes semantic scroll actions.
5. Run `background`, `barrier`, then `kill`. All existing package hashes, user/UID,
   system Bundle, exact ActivityRecord/task and actual old-PID absence checks stay
   enabled. The referenced body is also read after the old process disappears.
6. Run `restore` once. Its first stage verifies the actual incoming OS Bundle and
   pre-guest saved/empty-retained channels. It then automatically captures the
   held-response checkpoint and releases request 2; do not insert a human pause
   inside that operation. The coordinator reserves time before the server's hard
   deadline and shortens its own ADB waits to the remaining window. Production
   HTTP timeouts are unchanged.
7. Run `validate`. It requires exactly two successful `GET` requests to the exact
   privacy endpoint (an increase of one across process death), the same body R
   through the held loading observation, canonical anchor `{index:0,offsetPx:0}`,
   and semantic geometry matching the original top. Whole persistent KV bytes
   must retain their seeded digest throughout.

The held barrier brackets both the new-process snapshot and raw body read with
the same server request still held. At that moment the compact saved entry must
retain the original non-null body reference R while reporting
`isLoading=true`, `listAnchor=null`, and zero compatibility offset; the document
list must be absent from the semantic tree. This distinguishes the observed
loading reset from missing-file hydration fallback. Only after that evidence is
durably saved may the coordinator publish `release-2.json`. A missed window or
uncertain release records failure and permits only `collect`; it cannot be
retried into a passing result.

`legal_probe.py` validates exact v2 metadata, owner/page/URL identity, canonical
owner/hash/allocation paths, file byte length/SHA-256/UTF-8, and anchor/semantic
outcomes. The coordinator additionally binds its cached observations back to
the durable snapshot acknowledgements, process identities, event order and KV
receipts. Raw recovery files are read only from the isolated package's
`files/podjs/files/legal-recovery/v1/` subtree, with symlink/hardlink checks.

This scenario proves the observed held-loading anchor reset after an externally
terminated process. It does not assert exact candidate-consumption or mount
event counts, a true-fast branch, pixels, physical gestures, actual low-memory
pressure, or performance. The disabled fixture event logger is never excluded
from the KV comparison. Stop the owned server and remove only the owned reverse
mapping after collecting the final evidence; the coordinator does neither.
