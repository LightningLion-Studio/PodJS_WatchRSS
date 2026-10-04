# Note synchronization integration

The main foreground session now dispatches `syncNotes` through `createApplicationActionHandler` to the existing memo repository. Responses use the native note protocol version 1, include the watch device identity and all notes including tombstones, and exclude derived `plainText`. Incoming payloads are parsed completely before any row is applied. Handler failures return a failure response, allowing a persistent session to continue. Successful note actions notify the notes list to refresh.

The merge condition follows the current native `WatchNoteRepository.merge`: apply when local is absent, remote updatedAt is greater than or equal to local, or local contentHash equals its baseContentHash. Thus even an older remote note overwrites an unmodified local baseline; a newer dirty local note rejects an older remote note. Duplicate IDs are processed in request order. Deletion is stored and exported, with tombstones excluded from the visible list.

Native references: `phoneconnection/bluetooth/WatchNoteSyncPayload.kt`, `WatchBluetoothSyncServer.kt` and `data/note/WatchNoteRepository.kt`. These were inspected directly; no Kotlin oracle was executed in this increment.

Verification uses real SQLite in unit tests, an actual `LibrarySyncSession` persistent frame exchange with applied ACKs and a rejected action, and the isolated Android guest `tests/runtime-note-sync`. The watch guest exercised the production handler and host SQLite for import, clean baseline overwrite, dirty protection, equal-time tombstones, export and malformed-batch rejection. It removed only its owned fixture row and checked article counts stayed unchanged. Raw records: `artifacts/notes-sync-all-unit.log`, `notes-sync-typecheck.log`, `notes-sync-guest-kv.json`.

This is not complete note feature parity. Paired-phone note exchange, note image resources (`syncNoteAsset`), large payload/frame limits, concurrent editing and visible detail-page refresh still need verification or implementation. [The subsequent text/refresh increment](note-text-and-live-refresh.md) added native HTML/entity conversion with 73 executed oracle cases and screen refresh hooks; visible refresh remains unverified because a system charging warning obscured screenshots. Unsupported actions continue to fail explicitly.

The subsequent [note asset receiver](sync-note-assets.md) adds validated file transfer; rich note image rendering and paired-phone validation remain pending.

A subsequent [physical paired-phone protocol test](paired-note-sync.md) verified notes, two-chunk PNG transfer, conflict handling and applied ACKs in one persistent session. It uses an Android instrumentation client; the normal companion-app flow remains pending.
