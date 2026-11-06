# P3B isolated space and local recovery entry

`watchSpaceV2` is exported by the existing sync-v2 entry. It is inert unless
`enabled: true` is supplied. There is no startup hook, automatic scheduling,
account selection, UI copy, remote lease, custody release or production origin.
`store.setAutoEvict(true)` is a separate explicit setting, defaulting to false.
The caller owns execution windows, trusted time and UI events.

The factory receives the P2 projection and P3 content engine. `adopt` accepts
only an authenticated **download** descriptor. Original imported sources and
upload caches are never registered for deletion. Current account rows, immutable
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

The required `source(refs, changes)` port must derive/verify the **complete**
necessary recipe/blob closure for these set values, including attachments. It
must reject omissions and dangling references. This is a local authenticated
object port, not HTTP. Each returned sealed object is hash-checked again and
wrapped with the independent recovery key in 64 KiB chunks. Plaintext, source
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
