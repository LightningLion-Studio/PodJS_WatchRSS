# Sync v2 P2 (Watch, isolated integration only)

The opt-in `watchSyncV2()` factory is exported from `src/sync-v2/index.ts`.
It has no application startup hook. Both `enabled` and `indexWrite` default to
false. The transport only accepts an HTTP loopback origin. The existing cloud,
Bluetooth v13/v14, pairing and business databases retain their existing paths.

Apply `framework.patch` to PodJS `a48eafeb083ab5d82ae92dc36c44fb442669f9cb`
before building this branch. Its PocketJS dependency is fixed at
`5f76221c21057a37db2926bc141effc06b933924`. Test/build output and the patch
are delivered under the task evidence directory, outside this repository.

## Trust and wire

- C1 derives accountId from the authenticated user UUID. The old
  `x-watchrss-cloud-device-id` remains the old approved device identifier.
- C2 uses the six frozen `x-watchrss-sync-*` raw PUT headers.
- C3 pins the authenticated bootstrap service SPKI and keyId by account in the
  existing protected store. Key changes stop reads and writes. Capabilities
  must match the bootstrap bytes. No key rotation is accepted.
- C4 verifies the original K_id-HMAC and possession signature unchanged, then
  verifies the separate service-signed deviceMapping and current legacy approval.
- C5 checkpoint verifies the generic version/scope envelope and the original
  service signature over the device-sorted refs and captured account window.
- C6 tests wrong generations without advancing the shared rollback generation.
  Actual rollback and post-rollback old-generation acceptance remain P3.
- Native author keys have separate AndroidKeyStore aliases, strict SEC1/P1363
  low-S conversion and a missing-key sentinel. They never reuse ECDH keys.
- New envelopes obtain CSPRNG salt/nonce before computing final AAD. Identity
  encoding is produced; authenticated gzip input uses a single-member bounded
  native decoder. The old crypto APIs retain their behavior.

## Persistence and acknowledgements

P1's encrypted state and its stateVersion/business witness CAS remain the single
writer fence. New current index rows, pending upload bytes, quarantine objects
and permanent signed headers use separate encrypted SQLite records. Raw control reads retain the negotiated windowId. A complete
current pointer changes only after all tree/meta/state and empty state-refs
closures authenticate. A failed staging pass cannot expose a partial current
index. Unrelated ancestry objects do not change accepted author pins.

The author sequence is reserved before signing. Pending publication stores the
exact signed double-CAS request and its object bytes before HTTP publication.
A retry first queries the original requestId. Conflicts preserve the original
request and local edits. An advanced overlapping account with no proven merged
business basis returns merge_unavailable; it never rewrites expected refs.

Publication advances only the captured local upload watermark. It is not a
business applied ACK. This adapter does not send `/acks/applied`. A received
cloud index does not silently change the native business edit baseline. A later
native edit after a rollback therefore still enters the existing choice barrier.

Current rows provide `placeholder` and `placeholderText`. A promise displays
“正文尚未就绪”; a recipe without a local body displays “正文尚未下载”. No
body worker is started. History returns only OIDs and directory metadata.

## Notes

The materializer includes every original note_merge_conflicts row, including
resolution markers retained in the additive sidecar if present. Records stay in
state ciphertext; no conflict feature is emitted into the public index row or
commit. The shared rc6c planner rejects unresolved conflicts and missing/cross-
generation provenance. The SQL equivalent legacy branch uses an instance-private
proof, a whole-state hash, two checks and the shared stateVersion CAS. It cannot
change text, remove entities or introduce entities. Original inbox bytes remain.

The note conflict resolution planner produces a bounded private candidate. It
is not a native editor transaction or a physical attachment reservation. Its
local/remote/manual UI and attachment custody integration are not activated here.
Substantive legacy three-way text merge and account-choice apply remain closed.

## Validation

Run `bun test tests/sync-v2`, `bun run typecheck`, and `bun run test` after applying
the framework patch and installing the fixed dependencies. Fixed vector JSON is
read directly from the shared task vector directory. No vector generator is run.
The framework adds `bash scripts/test-sync-v2-crypto.sh` and isolated Android
instrumentation tests for signing persistence and missing-key rejection.

Production, real accounts, physical devices, body workers, note segments,
rotation, history restore, local_objects, GC and automatic content eviction are
outside this integration entry point.

The opt-in emulator harness is documented in `tests/sync-v2/emulator/README.md`.
It reads only the synthetic watch fixture at runtime and preserves existing
SQLite state. Legacy clients retain structured `upgrade_required` from HTTP 426
and display the upgrade action instead of treating a v2 account as an empty library.

Books require both string H64 identity fields and the existing fingerprint-derived
bookId (with the instance domain when instanceId is present). `bookIdInput()` shares
the exact derivation bytes between the existing book module and the synchronous
v2 wire validator. The reader audit binding includes the business validator
revision, so older successful checkpoints cannot skip a stronger validation pass.
Publication also validates previously cached current rows and candidate payloads.
An invalid cached book cannot be propagated by a new signed index.

Section 14 sort orders retain their original signed I53 values in v2 reading
records. A private validation-only copy adapts the legacy nonnegative sort checks;
all other legacy field/type/clock/coupling validation remains active. Serialization
uses the original record. Legacy v13/v14 validators and merge behavior are unchanged.
