# PodJS WatchRSS migration contract

This contract defines the compatibility boundary for replacing the Android watch client. It is derived from `WatchRssDatabase.kt`, entity classes, stores, and the current (dirty) sync implementation. It does not authorize destructive conversion of a live database.

## Database compatibility

Current Room database version is **18**. The compatibility reader must recognize the database file name/location from the Android package, inspect `PRAGMA user_version`, and preserve unknown columns/tables during a staged migration. Do not use a destructive drop-and-recreate path.

The v18 logical tables are:

| Table | Contract |
|---|---|
| `rss_channels` | `id`, `url`, `title`, `description`, `imageUrl`, `lastFetchedAt`, `createdAt`, `sortOrder`, `isPinned`, `useOriginalContent`, `continuePlaybackInBackground` |
| `rss_items` | `id`, `channelId`, `title`, `description`, `content`, `originalContent`, `link`, `guid`, `pubDate`, `imageUrl`, `audioUrl`, `videoUrl`, `summary`, `previewImageUrl`, `isRead`, `isLiked`, `readingProgress`, `dedupKey`, `fetchedAt`, `contentSizeBytes`, `syncBodyHash`, `syncBodyByteCount`, `syncChunkSize`, `syncChunkHashesJson`, `syncMetadataHash`, `readingPositionBytes`, `readingPositionContentHash`, `readingPositionChangedAt` |
| `saved_entries` | `id`, `itemId`, `saveType`, `createdAt`, `sortOrder`; unique `(itemId, saveType)` |
| `offline_media` | `id`, `itemId`, `mediaType`, `originUrl`, `localPath`, `createdAt`; unique `(itemId, originUrl)` |
| `saved_sync_states` | `articleId`, `saveType`, nullable `itemId`, `url`, `saved`, `changedAt`, `sortOrder`, `sourceDeviceId` |
| `sync_change_log` | `seq`, `kind`, `entityId`, `changedAt`, `originDeviceId`, `reason`, `createdAt` |
| `sync_peer_state` | `peerDeviceId`, `lastLocalSeqAckedByPeer`, `lastRemoteSeqApplied`, `lastFullSyncAt`, `lastProtocolVersion`, `updatedAt` |
| `rss_source_sync_states` | `url`, `sourceDeviceId`, `title`, `description`, nullable `siteUrl`/`imageUrl`, `createdAt`, `updatedAt`, `sortOrder`, `isPinned`, `deleted`, `deletedAt` |
| `reader_presets` | `id`, `name`, `payloadJson`, `updatedAt`, `modifiedBy`, `deleted` |
| `reader_font_assets` | `id`, `sha256`, `displayName`, `familyName`, `fileName`, `mimeType`, `byteCount`, `faceCount`, `metadataJson`, `updatedAt`, `modifiedBy`, `deleted` |
| `reader_background_assets` | `id`, `sha256`, `displayName`, `kind`, `mimeType`, `masterFileName`, `byteCount`, `durationMs`, `width`, `height`, nullable `posterAssetId`, `variantsJson`, `updatedAt`, `modifiedBy`, `deleted` |
| `reader_deletions` | `kind`, `entityId`, `deletedAt`, `deletedBy` |
| `watch_notes` | `noteId`, nullable `folderId`, `title`, `markdown`, `plainText`, `contentHash`, `baseContentHash`, `baseMarkdown`, `pinned`, `createdAt`, `updatedAt`, `modifiedBy`, `deleted`, `deletedAt` |
| `watch_note_folders` | `folderId`, `name`, `sortOrder`, `updatedAt`, `modifiedBy`, `deleted`, `deletedAt` |
| `llm_token_usage` | `id`, `provider`, `model`, `requestId`, nullable token count fields (`promptTokens`, `completionTokens`, `totalTokens`, `reasoningTokens`, `cachedPromptTokens`, `inputTokens`, `outputTokens`, `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`), `createdAt` |

Preserve foreign-key cascade behavior from channels to items and items to saved/offline media. Preserve boolean and timestamp meaning; do not coerce missing timestamps into “now”. Keep hashes and JSON fields byte-for-byte where possible.

## Android store/file compatibility

The migration must inventory and either import or explicitly mark unsupported these stores before first run: `settings.preferences_pb`, `bili_cache.preferences_pb`; SharedPreferences `app_resume_state`, home placement (`notes_sort_order`, `notes_pinned`), `douyin_watch_history`, `douyin_recent_window`, `douyin_feed_cache`, `watchrss_announcement`, `watchrss_push`, device identity (`device_id`), installation identity (`install_id`, `first_installed_at`), telemetry daily keys, cloud state, reader active/theme/schedule/location keys, and WebView scale key.

EncryptedSharedPreferences stores are sensitive and must be migrated through Android Keystore-backed APIs or a user-mediated export. Relevant names/keys include account `state_json`, LLM `llm_api_key`, TTS `tts_api_key_<provider>`, and cloud ECDH keys under `watchrss_cloud_ecdh_<hash>`. Never copy ciphertext into a differently configured crypto store and claim compatibility; verify read-back and fail closed if keys cannot be opened.

The Android cloud cache directory is `files/watch-cloud-cache`; preserve or invalidate it only after validating snapshot identifiers and hashes. Log uploads and imported content may be in app files/cache and need separate inventory.

## Bluetooth wire contract

Use RFCOMM service `bb2f0b7d-8f2f-4a96-95b2-d2c91d58a861` and UTF-8 JSON frames with a 4-byte big-endian length prefix, maximum 2 MiB. Library protocol v14 accepts phone v13 or newer; retain a v4 parser only if old phones are explicitly supported. Negotiate and record capabilities before selecting behavior.

The v14 library exchange must preserve cursor/manifest/probe/article/complete phases, article body hashes and chunk hashes, metadata-only articles, saved-state timestamps/tombstones, reading progress and byte positions, source identity, and received/applied ACKs. Batch limits are 256 article requests and 512 manifest entries. Persistent sessions are opt-in and expire after 15 minutes idle.

Dirty Android changes add an authoritative mode boundary: `merge` remains default; `phoneToWatchReplace` applies the incoming snapshot as authoritative and removes absent articles/sources, then clears sync logs/peer state; `watchToPhoneReplace` treats the watch as source and resets peer state. `clearLibrary` is destructive and must be separately gated in the PodJS UI and protocol adapter. `forceFull` bypasses incremental cursor selection. These behaviors are source-derived and remain **NOT VERIFIED** on a real pair.

Other action versions: account sync v1; notes and note assets v1; reader preview v2 (legacy v1 accepted); IP sync v2. Do not silently downgrade a peer that advertises less than phone minimum v13.

## Cloud/API boundary

The watch cloud client calls the configured Supabase-compatible base for `/functions/v1/cloud/bootstrap`, `/devices/register`, `/snapshots/heads`, `/snapshots/reserve`, `/snapshots/complete`, and `/snapshots/{snapshotId}/ack`. Payload format is `watchrss-cloud-snapshot`, with encrypted manifest/chunk labels documented in `WatchCloudCrypto.kt`. Providers for LLM/TTS are configurable; defaults in source include OpenAI, DeepSeek, Qwen, Zhipu, MiniMax, Doubao, and Azure endpoints. Secrets stay in secure storage and are never part of migration logs.

## Migration procedure and proof

1. Copy the complete Android app data set, calculate file hashes, and work only on the copy.
2. Read schema/version and every store key; produce a machine-readable inventory with counts, nulls, and unsupported fields.
3. Import into PodJS staging storage transactionally. Keep an untouched source copy and a rollback marker.
4. Reopen the migrated store, compare row counts, primary keys, content hashes, saved states, tombstones, progress, notes, presets and asset metadata; verify representative rendered articles.
5. Pair with an Android v14 phone and test merge, phone-to-watch replace, watch-to-phone replace, forced full sync, reconnect/resume, received-versus-applied ACK, and clear-library confirmation. Then test a v13 peer for the negotiated minimum.
6. Only after all comparisons pass, make the migrated store active. Preserve the source until the user explicitly authorizes cleanup.

Acceptance remains **NOT VERIFIED** until the copied v18 database and secure stores have read-back evidence and target-device UI/transport evidence. A successful build, parser test, or Bluetooth handshake is insufficient.

## PodJS sync codec coverage

| Portion | Current codec status | Manager/device work still required |
|---|---|---|
| RFCOMM constants and 4-byte big-endian UTF-8 framing | Implemented and unit-tested; 1..2 MiB bounds and arbitrary stream reassembly covered | Open RFCOMM service and prove physical transport |
| v14 negotiation and phone minimum v13 | Implemented and unit-tested | Exchange capabilities with a real phone and handle downgrade UX |
| Probe payload | Implemented with conservative false defaults; canonical Android-shaped fixture requires explicit capability flags | Supply only capabilities backed by implemented PodJS handlers |
| Library phase validation | Implemented for `cursor`, `manifest`, `probe`, `articles`, `complete` and action/version shape | Implement cursor/manifest/article orchestration and timeout/retry state |
| Article chunk Base64 and SHA-256 verification | Implemented with injected SHA-256, exact-byte checks, and conflicting duplicate rejection | Host must inject a native SHA-256 implementation; rebuild and verify complete bodies |
| Manifest/body metadata, change sequences, saved tombstones, reading positions | Not implemented in codec | Implement v14 payload builders/parsers and repository application semantics |
| ACK/session/replace/clear actions | Constants exist; no session manager or destructive operation | Add received/applied ACK lifecycle, persistent-session timeout, confirmations, and replace/clear safeguards |
| Reader/account/notes/assets/cloud/IP transports | Not implemented | Separate adapters and end-to-end tests; do not infer support from probe flags |
