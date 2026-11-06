# P3A isolated content entry

All content gates default to off. No startup hook, timer, account operation or
worker is registered by these imports. Only a loopback test backend is accepted.
P3A does not delete or replace original business bodies. Note segmentation,
automatic eviction, custody release, key rotation, and local object framing stay
closed.

The existing `watchSyncV2` factory returns `content(businessPorts)`. This creates
a separate content HTTP/native lane using the same pinned service identity,
registered author, scope, and content keys. The business ports supply:

- `enabled: true` only for an authorized isolated test run;
- a stable `authBinding`, so a changed authentication binding gets a separate
  encrypted projection/cache namespace;
- `source(binding)`, returning immutable size/ranges, bounded `read`, and
  `assertCurrent` checks for the original business revision;
- optional live authenticated session leases and the charging-cellular setting.

`contentBodyResolver(engine, describe)` is passed as `watchSyncV2.bodyResolver`.
The describe callback maps a validated candidate to its stable body revision,
source binding, import metadata, and parent classification. Ordinary state edits
must retain the same body revision. A content or authentication change invalidates
only its affected binding. Do not read the entire source merely to describe it.
A deferred closure can capture the content engine after `runtime.content()` opens.

C10 ordering is mandatory:

1. Call `engine.runWindow()` in an OS-owned execution window. Uploads stop only
   after complete/present and immutable recipe-refs registration.
2. Call the P2 `runtime.publish()` path. Its double CAS publishes the exact recipe
   fields returned by the resolver. Preserve the P2 journal on conflicts/loss.
3. Authenticate the current account with the P2 reader. Pass its authenticated
   body rows to `queueAuthenticatedBody`; then run a content receive window.
   Availability is checked only on this bound receive path. It is not an upload
   prerequisite or a P3A deletion authorization.

`runWindow()` does not schedule another window. Every content HTTP request is
admitted before dispatch, with its 10 second transport bound and shutdown reserve.
An expired full-prefix reservation is renewed before the C8 have/want retry.
Neither path reexports a confirmed body. C11 treats a reserve replay only as a
reservation identity. Resume uses have/want, after verifying its signed scope,
OID, total and durable offset, against the encrypted local frame high-water mark.
A server-ahead receipt is checkpointed before another frame. A server-behind
offset repairs at most 65536 bytes; a greater rollback fails `offset_conflict`
without lowering the checkpoint. Every frame ACK is checkpointed before the next
frame. The same rule applies to P2 control uploads; their encrypted receipt
journal is removed with the accepted/retired publication plan.
The owner must preserve the
300 second/10 second reserve and 8 MiB budget. Conditions are rechecked at frame
boundaries. Unknown conditions wait. Demand never bypasses these gates.

C9 demand lists are read at each window start, with refresh admission at 20 seconds
(the transport has a 10 second total timeout), and immediately after POST. The
runtime adapter refreshes authenticated approved author bindings before accepting
a list. Invalid/unapproved requesters do not grant priority. Expiry is checked at
each subsequent frame boundary against the observed server clock.

Local records and proof checkpoints are encrypted. Exact remote receipts are
queried before reading an upload cache; confirmed queue entries cause no source
or body-cache scan. A prepared/authenticated immutable file plus its bound proof
can be adopted after a lost checkpoint reply. Files without a completed proof
remain unconfirmed. None of these states is a business applied ACK.

Tests:

```
bun test tests/sync-v2/p2.test.ts tests/sync-v2/p3.test.ts
bun tests/sync-v2/p3-stress.ts /path/to/evidence.json 1800
ANDROID_SDK_ROOT=/home/wilf/Android/Sdk bash tests/sync-v2/emulator/run-p3.sh \
  /path/to/framework-worktree emulator-5578 /path/to/evidence
```

The stress program uses real codecs/files/SQLite and a synthetic in-memory HTTP
server with virtual network time. Its process RSS includes the synthetic server
and is not a device memory measurement. The emulator harness uses synthetic data,
Android crypto/SQLite/fsync, and QuickJS. It does not contact an account or backend.
