This is an explicit integration harness, separate from product startup and the
normal Bun test suite. It runs the real watch sync-v2 modules in the Android
QuickJS headless runtime. Android performs HTTP through adb reverse, cryptographic
operations and local SQLite transactions. The test-only signer loads the fixed
synthetic watch private key in JCA; it does not replace the product's independent
non-exportable AndroidKeyStore signer. The test native secure-store constructor
uses an injected synthetic AES key; no claim of production key protection is made.

Use only the isolated watch fixture. Never embed the fixture in source, APK assets,
command arguments or logs. The instrumentation reads an app-private file and
injects it into QuickJS memory. Only controlled result events are exported.

Backend 1a2378f satisfies C5. The complete emulator run passes checkpoint,
legacy upgrade handling, full snapshot publication, CAS reread/retry, concurrent
request replay with lost responses, exactly one account event for the replayed
request, and all three peer snapshot audits. C6 rejects signed generation 1 and
9007199254740993 while the account remains generation 0. Real rollback stays in P3.

The main projection SQLite database is reused. Expired unknown requests are
resolved before retiring journals; candidate edits and signing sequences survive.
The CAS case inserts one separately signed competing request, expects the original
CAS to fail, authenticates the new account and prepares a new request. Two actual
HTTP worker threads then send identical final request bytes. Both results must
match; their response is discarded and recovered through the original request ID.
Only the final commit is counted in the account event assertion; unrelated peer
commits are permitted. The competing request is a separate logical transaction.

Each peer audit uses an independent app-private SQLite database. Its test-only
account slot represents that device snapshot, not account/current. The bootstrap
proof is the captured C5 service signature over the exact device ref. The normal
watch reader still authenticates the complete author/account parent chains,
control closure and decrypted business IDs before the audit pointer is committed.
The real account pointer is not changed by an audit. No business applied ACK is
sent. Blob/recipe body requests are forbidden by the test transport.

Build and run (requires the independent patched framework worktree and an already
booted owned emulator):

```sh
bash tests/sync-v2/emulator/run.sh <framework-worktree> <emulator-serial> <evidence-directory>
```

The runner rejects physical serial numbers. It does not start or modify a backend.
The report at `.codex-tmp/cloud-v2/reports/T-SYNCGIT-P2-watch.md` records exact
commands, limits and observed results. Framework crypto/Keystore acceptance and
this synthetic-key integration are separate evidence.

Read-only four-device re-audit (no publication or generation probes):

```sh
bash tests/sync-v2/emulator/run.sh <framework-worktree> <emulator-serial> <evidence-directory> audit
```

The audit mode verifies all four captured C5 refs, including the watch ref. It
also reopens the three public historical OIDs recorded by the prior run. Only
controlled identity/shape validation counts are exported. Legacy bootstrap
platform labels for phone-backed CLI/mini sessions are not treated as role labels;
role labels use the public fixed device mapping in the cross-client reports.
All book rows must have string H64 fingerprints and the correct derived bookId,
including instanceId when present. The normal reader and a separate raw-envelope
inspection must agree. No body download, account publication or business apply
occurs in this mode.

P3A live content acceptance (opt-in; product startup remains disabled):

```sh
bash tests/sync-v2/emulator/run-live-p3.sh \
  /home/wilf/data/PodJS/podjs-watch.wt-syncv2-p3 \
  emulator-5578 /path/to/owned/evidence/attempt
```

This runner additionally verifies the AVD name `WrssP3WatchLive`. The owner must
create that isolated Wear OS emulator and stop/delete it after acceptance. The
runner installs `adb reverse tcp:18942 tcp:18942`; the guest only accepts the
loopback integration backend. No backend service or database is stopped/reset.
The fixed synthetic watch fixture is loaded from an app-private file, never from
compiled assets or command arguments. The file is removed after the run.

`P3LiveIntegrationTest` uses real Android `PodHttpServices`, `PodContentFiles`,
SQLite and crypto, with a separate content network executor. The guest runs the
product P2 reader/publisher and P3 engine. It uploads complete bodies, drops real
successful prefix/tail PUT responses, queries signed have/want, replays the exact
original reserve request, and verifies no repeated body frames. It checks C9
POST/GET demand, rank0 selection and waiting conditions. Real authenticated
`events?waitMillis=0` requests and local small-state transactions run concurrently
with PUT. The final checks authenticate current account rows and download one
complete body from each available peer author, including recipe, block and full
plaintext fingerprint checks. Completed sources are checked for zero reexport.

The CAS probe first submits a separately signed watch request for the prepared
commit. This advances the shared ref while preserving its complete captured tree.
The original request must fail CAS; the normal P2 reader authenticates the new
head and the normal publisher prepares a new commit. No peer rows or refs are
cleared. No body is exported again during this retry. Test rows remain available
for other clients' read-only interoperability checks.

Fresh emulator storage lacks the old watch's local signing reservation journal.
`live-p3-watermark.py` reconstructs the fixed synthetic lower bound from the
retained P2 `c5-full/summary.json` and its guest source: the successful publication
was followed by two C6 probes, each reserving another sequence. It then retains
every subsequent local `author-reserved` event in `../author-watermark.json`.
The guest authenticates the old witness commit or a newer own ref before seeding
its NEW test projection. This is explicit test recovery from retained evidence;
it does not add a production recovery policy or derive a sequence from time.
Keep that public journal with the evidence between runs. Never replace the
original signing binding or reset shared server objects to resolve a collision.

Synthetic signer protection is unchanged from the P2 harness: JCA loads the fixed
test private key, and native local storage uses an injected test AES key. This
proves wire/codec interoperability, not production non-exportability. Full app
UI, physical watch power and production accounts remain outside this harness.

P3B live storage/eviction acceptance uses `run-live-p3b.sh`, the owned AVD
`WrssP3BWatchLive`, `integration-p3b/watch.json`, and port 18952 exclusively.
See `docs/sync-v2-space.md` for the full invocation and negative cases. The new
runner never reads or modifies the original 18942 fixture or service.

C7 review F2 memory probe (synthetic loopback server, owned emulator only):

```sh
ANDROID_SDK_ROOT=... bash tests/sync-v2/emulator/run-c7-memory.sh \
  <framework-worktree> <emulator-serial> <evidence-dir> \
  1:publish:32:flush 1:pull:24 20:publish:32:flush 20:pull:24
```

Each run is `notes:mode:limitMiB[:flush]` and starts a new instrumentation
process. `publish` scans N long notes (`WRSS_C7_NOTE_CHARS`, default 36000 CJK
characters per field) and prepares; `flush` also uploads after resetting the
synthetic account. `pull` reads that account into a fresh database, then
prepares one unrelated edit. The guest memory limit is the QuickJS runtime
limit; out-of-memory is recorded, not asserted. `peakHwmKiB` is the process
VmHWM. The server (`c7-memory-server.ts`) generates one synthetic key per
process and writes the fixture with mode 0600; `WRSS_C7_SERVER_FIXTURE` reuses a
running server so two checkouts can share one account.

Product limits the probe works around and reports: `PodDeviceServices` rejects
`crypto.aesGcm*` input above 256 KiB, `localProjectionCipher` rejects plaintext
above 768 KiB, and one background host request is at most 1 MiB. The Java test
seals larger local values itself (`oversizedLocalCipherCalls`) and the guest
lifts the 768 KiB check (`oversizedSeals`), so measurements are of guest memory,
not of product acceptance.
