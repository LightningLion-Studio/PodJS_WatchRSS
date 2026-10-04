# Reader preset live preview

The shared RFCOMM/IP dispatcher implements native `previewReader` version 1/2 requests: full preset updates, deltas, heartbeat, resource handoff and stop. Preview state is ephemeral and does not save presets, reading progress or favorites.

## Session and screen

A new session accepts its initial sequence; an existing session rejects stale updates. Deltas require a baseline, consume the accepted sequence before decoding (matching native behavior), replace nested style objects and coalesce publication at 33 ms. Heartbeat and normal updates expire after 20 seconds. Resource handoff uses 120 seconds; background/variant resource pushes refresh an active handoff. Stop and expiry remove pending publication and restore the underlying screen.

The screen uses the native nine sample paragraphs, system-shaped text and preset typography, links, solid colors and favorite/share decoration. During resource handoff it retains the last rendered preset while displaying the transfer label. It holds a scoped keep-awake owner while visible and releases it on exit. Favorites/sharing are illustrative and do not change user data.

Local custom fonts are now rendered and two native paragraph profiles have exact pixel comparison; see [reader-fonts.md](reader-fonts.md) for the current deployment and precise comparison region. Image/video background rendering now has bounded native and playback evidence in [reader-backgrounds.md](reader-backgrounds.md); physical visual acceptance remains open. The results below describe the earlier preview deployment.

## Text file lifetime

Releasing a text line used to cancel result delivery while Android could already have created its RGBA file. Without the result path, JavaScript could not remove that file. The framework now drains an already-started raster result and deletes its file even if all consumers have gone away. Released lines do not read/upload late pixels; pixel reads already in flight finish before deletion. At most two loads run and cancelled queued lines never start. Cleanup is included in the active-load lifetime.

The initial main-app protocol probe exposed two such temporary files. Their absence in the original backup and their live hashes were checked before removing exactly those files. The initial deployment snapshots remain in `artifacts/reader-preview-initial-deployment`; the final audit compares against both the fresh baseline and the original baseline.

## Verification, 2026-09-14

- All 466 application tests, typecheck and production build pass. Three isolated text-lifetime tests cover late completion, disposal during a read, shared texture references and cancelled queued work. The 28 SDK service tests also pass.
- A desktop JVM oracle executes the original Kotlin preview session and wire parser with Android JSON sources: 13 wire cases, coalescing and expiry. This is backend comparison, not Android UI parity.
- An isolated app on the physical watch rendered the production preview screen through full update, red/larger text delta, handoff, green background update, stop and 20-second expiry. TextureView snapshots show zero changed pixels in the 179,876-pixel content region during handoff. Instrumentation verified keep-awake release and unchanged preset storage without synthetic mouse/keyboard/gesture input. This UI fixture predates the text cleanup fix; the final fix is covered by lifecycle tests and the main-app phone probe/data audit.
- Installed main APK SHA-256: `7158f780666118197da1a0677c229a6b2bbed072b25229b5ac2483ceb4af2c41`. An authenticated physical-phone probe passed seven preview requests, a two-preset manifest read, three empty token-history requests and two library probes in 8.572 seconds. Its temporary ADB relay is explicitly labelled; actual wireless operation is unverified.
- The final stopped snapshot has the original 191 files. All 30 application tables and 188 non-database files match the original baseline; the only allowed non-database change is WorkManager's force-stop timestamp, whose other tables match. No extra preview text files remain. Main location permissions and disabled Wi-Fi are unchanged. The immediate pre-install observer snapshot was taken before asynchronous registration; both active and resumed snapshots contain two observers, and stopping removes both.
- Owned fixture packages and temporary relay rules were removed, and the main application resumed. Existing unrelated test packages were retained.

`artifacts/reader-preview-deployment-receipt.json` and `scripts/verification/collect-reader-preview-receipt.py` bind the installed APK, source hashes, tests, UI fixture and data-preservation evidence. Older receipts are historical. Full WatchRSS migration, native companion UI acceptance, broader background qualification, and physical visual/Wi-Fi acceptance remain incomplete.

Physical-phone Bluetooth resource upload and the resulting font/image/video preview are subsequently verified in [reader-resource-transfer.md](reader-resource-transfer.md).
