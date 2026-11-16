# Library Binary v2: S2 pure core

This directory is an opt-in protocol library. No existing sync entry point imports
it. `RELEASE_B2_ENABLED` is `false`. This card does not advertise `libraryBinary`,
install a device transport, change the old journal, or enable cloud writes.

The frozen contract is `library-binary-v2.md` SHA-256
`3d1ed2b857be3d599d52221c02c04b2672f80b5b42e9443eaeab844632cad8cb`.
Fixtures under `tests/fixtures/library-binary` are unchanged spec/review inputs;
`SOURCE.json` records their raw-file hashes and Kotlin fixture names.

## Public pieces

- `wire`, `digests`, `codec`: strict schemas/UTF-8, B2 digest domains, complete
  `Uint8Array` CONTROL/DATA/ACK frames. `accountScope` remains the existing C-v1
  account commitment; do not derive a B2 account identity.
- `routing`: peer projection, directional capability intersection, explicit v1
  tasks, connection protocol pin, whole-selection receipt accounting, switch
  response write barrier. Local `s2Capability()` only accepts ready inherited
  kinds and forces 1 chunk / 65536 bytes. A peer may advertise future book kinds;
  this core never selects/advertises them for its own S2 job.
- `Preparation`: validates/persists offer and confirm bindings. The reverse job
  may begin only after confirm success is **fully written**. The first begin
  must match its confirm intent; subsequent resume retains that job's first plan,
  selection, snapshots and manifest page partition.
- `state`: one DATA pending per stream, exact byte settlement, ACK/negative
  association, epoch reset, fixed IDs on retry, token buckets/backoff, independent
  business/heartbeat slots, local generation fence, immutable stream bindings,
  separate directional object slots.
- `lifecycle`: manifest pages, roots/DAG/identity validation, peak reservation
  barrier, durable checkpoint restore, apply and completion receipt checks,
  immediate local cancellation fence. Chunk hash arrays stay in a disk-backed
  `RegisteredManifest` rather than a 4096-object in-memory manifest.
- `missing`: bounded disk-backed inventory, rechecks local chunk bytes, paginates
  real missing ranges and full business receipts. PLANNING `limit=0` never reads
  this data index or allocates an object slot.
- `recovery`: the three logical-task recovery rules, independent heartbeat/local
  work deadlines and network/half-frame deadlines. A semantic progress key must
  describe content/version; a new jobId must not make a new progress key.
- `connection`: one reader/writer, complete-frame priority queue, reserved control
  capacity, bounded raw frames, local fence on malformed input or I/O failure.

## S1 integration contract (separate card)

1. With `b2Enabled=false`, delegate directly to existing v1 code. Do not construct
   a B2 connection or advertise capabilities. Retain every old Base64 API/frame.
2. Classify and select routes **before business writes**. Validate actual native
   byte/storage/business-adapter readiness before creating `s2Capability()`.
   Keep B2 and v1 work on different authenticated physical connections.
3. Finish probe/stable identity/Ready/account checks and drain old ACKs. Use
   `SwitchGate`; write its old-format response completely before handing the
   single reader/writer to `BinaryConnection`. Preserve tail bytes from the same
   underlying read. Never send old `action:ack` for switch.
4. Implement `ByteTransport.readFrame/writeFrame/close`. Reject a length prefix
   with `frameAllocationBytes()` **before allocating**. Reads preserve one exact
   frame; writes handle partial I/O and never interleave. A partial frame at EOF
   is not durable. WebSocket requires one binary message per B2 frame and no
   compression/text. Codec helpers alone do not prove those host contracts.
5. Implement `JobJournal`, `MissingIndex`, `RegisteredManifest`, `DurableChunks`
   using the existing authenticated account scope and frozen source spool.
   Bind request ID/locator/digest atomically; recheck the provided grant callback
   at **every final durable or business commit**, not only before awaiting work.
   Validate object SHA-256/finalize/dependencies and existing kind schemas in the
   real adapter. Persist APPLIED with business rows/references in one transaction.
   Retain IDs/receipts/checkpoints for at least 24h; preserve terminal resume data.
6. An admitted receive window requires verified manifest root/DAG, native index,
   dependency readiness, directional object slot and full peak reservation.
   Admission failures must drain/hash the complete bounded DATA before a negative
   reply; the native stream adapter must provide the 4KiB scratch/60s drain
   contract. This pure core already receives a complete bounded byte frame.
7. Share `BinaryConnection.staleAckBudget` between both `SendWindow` instances
   (the fourth constructor argument); its 32/16 budget is physical-connection-wide.
   Bind `ControlSlots` to the authenticated receiver device ID for receipt checks.
   Reserve DATA credit at first write; do not resend a pending operation. A
   durable callback invokes the ACK writer immediately. QUERY/WAIT/BEGIN settle
   only the matching pending attempt; replay uses the same persistent ID/digest
   and a new txSeq. Apply sender backoff and the aggregate STATE bucket.
8. Regrant only the same stream job/plan/selection after the writer/native fence
   barrier. Use `ReceiveWindow.regrant()` to register the new connection-local
   grant; changing its `Grant` directly invalidates the window. Only epochs
   actually granted to this window may be discarded as old barrier frames. A
   fresh connection first granted epoch 2 must STOP on epoch 1, as on future epochs.
   Clear old pending/ACK/error work, reset sequences and query missing
   before resending. A different job/plan/selection requires closing both streams
   and starting a new physical connection. Old callbacks retain old grant tokens.
9. Drive authenticated/begun heartbeat slots every <=10s, including PLANNING and
   waits for manifest/durable/apply. Start the independent 30s heartbeat deadline
   at **write start**. On expiry close once and feed real SocketTimeout to
   `RecoveryRules.ioFailure()`. Actual local work units alone refresh the 30s
   local watchdog. Protocol/account/business/local failures call `stop()` and
   fence; they do not initiate network search. Route handoff calls `detach()` and
   preserves logical counters and semantic progress keys.

## Local checks

Use the task's `flock /tmp/wrss-heavy-PodJS_WatchRSS.lock capmem 16G` prefix for
Bun tests, type checks and builds. `bun test ./tests/library-binary/` includes 259
baseline v1 frame comparisons. Optional live baseline byte comparison uses
`B2_LEGACY_BASELINE_ROOT` (default sibling `PodJS_WatchRSS`); the frozen hash checks
remain self-contained. `bun scripts/lint-library-binary.ts` checks this core and
its tests for type errors and unused symbols. `bun run typecheck` checks the app.
