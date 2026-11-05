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

The initial backend integration is **blocked**: the delivered backend does not
percent-decode object path segments, so the first encoded raw PUT returns
`400 invalid_oid`. Do not run further requests until Claude provides a fix.

After the backend fix, resume with the existing encrypted publication journal.
The harness accepts empty initial accounts, refreshes and authenticates after CAS
conflicts, and retries response loss with the original request ID. It asserts that
same-instance concurrent flush calls share a promise. The old-generation live
check is still outstanding; the harness deliberately returns failure at the end
until that acceptance item is implemented and verified. Do not treat a future
partial run as all five integration checks passing.

Build and run (requires the independent patched framework worktree and an already
booted owned emulator):

```sh
bash tests/sync-v2/emulator/run.sh <framework-worktree> <emulator-serial> <evidence-directory>
```

The runner rejects physical serial numbers. It does not start or modify a backend.
The report at `.codex-tmp/cloud-v2/reports/T-SYNCGIT-P2-watch.md` records exact
commands, limits and observed results. Framework crypto/Keystore acceptance and
this synthetic-key integration are separate evidence.
