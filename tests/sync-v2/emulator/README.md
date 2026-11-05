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
