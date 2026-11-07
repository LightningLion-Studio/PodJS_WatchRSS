# P3B isolated space and local recovery entry

`watchSpaceV2` is exported by the existing sync-v2 entry. It is inert unless
`enabled: true` is supplied. There is no startup hook, automatic scheduling,
account selection, UI copy, remote lease, custody release or production origin.
`store.setAutoEvict(true)` is a separate explicit setting, defaulting to false.
The caller owns execution windows, trusted time and UI events.

The factory receives the P2 projection and P3 content engine. `adopt` accepts
only an authenticated **download** descriptor. Original imported sources and
upload caches are never registered for deletion. `adoptEntity(id, access)` derives RSS/import/note/image classification and stable
identity from the authenticated business row. Inline notes are protected state;
local image assets inherit memo protection. Current account rows, immutable
body revision, recipe, previously authenticated ordered blobs and readable key
version are matched before `/availability/check`. Only a valid, unexpired
`SignedAvailability` for `cloud-ready` authorizes a placeholder. C17 relies on
the backend to sign only the current reachable complete closure; no additional
wire is invented. An uploaded object or receipt alone does not authorize cleanup.
Assets and notes are conservatively protected. Any unsent business edits block
factory cleanup until a reliable per-entity clean witness is available.

Call `store.touch` before opening or editing an adopted item. This updates its
cache revision. Native business changes also fence the P2 stateVersion commit.
The same short transaction replaces the encrypted cache descriptor with a
placeholder, detaches its references, records deletion authority and marks the
P3 body plan evicted. Opening/editing during proof preparation makes the CAS
fail. Business metadata, business ID and addedAt are never rewritten.

The journal retires at most 32 unreferenced immutable files per batch, following
an application authorization callback and state CAS. Every resumed physical
deletion rechecks the current signed availability; an old persisted receipt
cannot authorize a later window. Offline/expired proof retains the physical
file. Shared owners and recovery owners prevent retirement. The native discard
operation returns the file size actually truncated under the file lock; retries
return zero. A persistent metadata cursor prevents failed candidates from
starving later garbage. Tombstones prevent retired paths from being reused.

`space.restore(id, download)` keeps the placeholder until the complete plaintext
SHA-256 matches, reading at most 64 KiB at a time. Re-enqueueing the evicted P3
body uses a fresh random cache generation and preserves its recipe/body revision.
The callback can use this P3 receiver and return its `derivedBody` resources.
Route managed reads through the returned `readRange` so placeholders are visible.
Raw encrypted transfer objects and their sidecars remain P3-owned. P3B releases
only derived plaintext files; freed bytes do not include retained ciphertext.

Metadata scanning is keyset-paged at 32 rows. A cache descriptor is limited to
8192 canonical plaintext bytes; oversized descriptors fail before deletion.
Preserve large business metadata in the business database and use a stable local
locator in the descriptor. Never load original bodies to describe a candidate.
Android `file.stat.usableBytes` supplies filesystem capacity. Missing capacity or
unknown/backward trusted time pauses cleanup. `space-insufficient` is an event;
Claude owns the eventual UI text. The time budget stops at operation boundaries;
each existing HTTP request still has its 10-second transport bound.

## N07: local-only recovery

The factory returns `recovery` using a distinct account/repo-bound local secure
key. The existing keep setting defaults to true. `recovery.setKeep(false)` only
affects future choices. Previous promises and pending edits remain intact.

After explicit cloud-choice confirmation, `recovery.applyCloud` receives a frozen
P2 choice capture, authenticated captured local/cloud business values and the
prepared business apply/ACK SQL statements. Partial legacy inputs must supply
`capturedKeys`; absence outside this set never means delete. Complete single
entity values pass the frozen business schema, so credentials and unrelated
snapshots are rejected. Only differences that lose local values are sealed.

The factory wires `WatchBusinessClosure.source(refs, changes)` directly to the
P3A content store; production callers cannot replace it with a synthetic source.
`contentBodyResolver` persists kind/logicalId/sourceBinding/bodyRevision bindings
and a witness of body identity fields. A changed article contentHash, book
fingerprint or asset body version cannot reuse a stale completed plan. Reading
state does not change that witness. Uploaded sources also recheck the original
immutable source guard; prepared ciphertext alone cannot bless a changed source.
The source matches each captured business value and original ID to its entityKey.
RSS articles, imported articles and books resolve complete durable content plans.
Notes keep Markdown inline and collect images from Markdown, baseMarkdown, and
all conflict texts, including resolved conflicts. Image assetIds derive the
normal keyed asset entityKeys. Missing mappings, files, blocks, durable offsets,
keys or reference tables reject the entire recovery preparation.

The source opens the sealed recipe, verifies its signed ordered reference table,
then authenticates every necessary blob, checking block fingerprints and the
whole plaintext hash with bounded object reads. Its returned readers bind the
persisted content-plan revision and read at most 64 KiB. Existing P3A receive
plans without a cached reference table verify the public table before use.
Recovery stores frozen business wire values; reading progress uses integer micros.
It never guesses a new body revision from a reading-state change.

Cleanup uses the completed AEAD/hash witness, recipe authentication and batched
stats/durable checkpoints, then a fresh `/availability/check` signed receipt.
It does not read complete blob bodies during cleanup. Signature, ordered OID
hash, lifetime bounds and expiry use the existing SignedAvailability verifier;
there is no extra assumption that two machines have identical millisecond clocks.
Each necessary recovery object is wrapped with the independent local key in 64 KiB chunks. Plaintext, source
files and ordinary demand caches are not copied wholesale. The factory provides
persistent worst-case quota reservation from app filesystem capacity; tests can
supply a deterministic reservation port.

Ciphertext and files are durable and checked before a single stateVersion CAS
records random copyId, pins, active/applied state and edit acknowledgement. Any
failure keeps the original active state, pendingChoice and edits. No recovery
HTTP operation exists. `restoreAsEdits` validates the pinned bodies and commits
explicit new local edits without changing the account ref or active pointer.

`purgeRecovery(trustedNow)` checks stable IDs, decrypted bodyRefs, matching pin
expiry and the persistent trusted-time watermark. The same CAS removes expired
ciphertext references, pins and file owners. Physical deletion follows that
commit. A crashed preparation conservatively retains its staging owner/quota;
it is not an expired committed recovery copy. Automatic orphan reservation
reconciliation is not supplied by this entry and must not infer deletion from
array positions or an untrusted wall clock.

## Verification

```
bun test tests/sync-v2/p3b.test.ts
bun tests/sync-v2/p3b-benchmark.ts /path/to/resource.json
ANDROID_SDK_ROOT=/home/wilf/Android/Sdk bash tests/sync-v2/emulator/run-p3b.sh \
  /path/to/framework-worktree emulator-5582 /path/to/evidence
```

The emulator harness uses synthetic SQLite, Android secure crypto, QuickJS,
app-private files and an in-memory HTTP fixture. It never uses a real account,
physical device, production backend or main checkout. Process RSS includes the
JVM and native host. A guest memory cap is not a measured guest heap peak.

## Isolated backend acceptance

```
ANDROID_SDK_ROOT=/home/wilf/Android/Sdk bash tests/sync-v2/emulator/run-live-p3b.sh \
  /home/wilf/data/PodJS/podjs-watch.wt-syncv2-p3b emulator-5584 /path/to/evidence/attempt
```

This opt-in runner requires the owned AVD `WrssP3BWatchLive`. It restricts both
control and native content transports to `127.0.0.1:18952`, installs adb reverse
only on that emulator, and loads the private `integration-p3b/watch.json` fixture
at runtime. Credentials are never compiled into the guest or printed. A separate
public author reservation watermark is retained between attempts; no 18942
fixture, clock-derived sequence, server reset or key replacement is used.

The product P2 reader/publisher and P3 workers upload and authenticate current
RSS/import/note/asset business rows. The product space factory, without a source
override, tests default-off behavior, real signed availability, placeholder and
fresh-generation download/hash/identity preservation for RSS and import. Notes
and images stay protected. Negatives use a rejected old revision, an actual
65536-byte partial upload, and a real backend signature checked with a controlled
expired verifier clock. The final local setting is off. Shared backend rows and
other client data are retained. Reports/evidence belong outside this repository.
