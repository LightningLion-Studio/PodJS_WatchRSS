# Note image resource synchronization

`syncNoteAsset` is now routed by the main application to `NoteAssetReceiver`. It implements native v1 storage-key and digest validation, 512 KiB chunk numbering, existing-target reuse, restart from chunk zero, strict Java basic Base64 syntax and final SHA-256 verification. Files use native-compatible paths `notes/assets/<key>` and `notes/assets/.<key>.part` inside the guest sandbox.

Each protocol chunk is written through multiple bounded SDK writes, because the Android file service accepts at most 256 KiB per request. Each append checks its byte offset. Validated staged files use the SDK's atomic replace operation, so a failed checksum never destroys an existing target. Like native, checksum failures retain the staged file and chunk zero restarts it. A serialized receiver queue prevents overlapping chunks from racing each other and remains usable after a failed request.

`scripts/reference/capture-note-assets.py` compiles the unchanged native `WatchNoteAssetSyncPayload.kt` and executes it with real temporary files on the desktop JVM. The oracle records response fields and every target/staging file size/hash after each step. Its eight scenarios and 22 steps cover empty files, duplicate reuse, full 512 KiB chunks, short/incorrectly ordered chunks, restart, checksum failure with an old target, invalid inputs, and trailing newlines in keys/digests/Base64. The PodJS tests compare actual filesystem states against those native snapshots, and an isolated watch guest replays the same cases using real host file services.

Complete or already-present resources trigger note refresh. This does not yet prove images are rendered: native `WatchNoteRichText` resolves `assets/...` into the note asset directory, while PodJS's rich note preview still needs that rendering path. Physical paired-phone asset transfer and visual fidelity remain pending. Main user data is not used as test input; isolated files are checked absent before testing and removed afterward.

Evidence: `artifacts/note-assets-receipt.json`, native capture, unit/typecheck/build logs and `note-assets-guest-kv.json`. The broader migration remains incomplete.

The following [structured preview increment](note-preview.md) adds asset path resolution, thumbnail loading and tiled preview; final visual and gesture acceptance remain pending.

A subsequent [physical paired-phone protocol test](paired-note-sync.md) verified notes, two-chunk PNG transfer, conflict handling and applied ACKs in one persistent session. It uses an Android instrumentation client; the normal companion-app flow remains pending.
