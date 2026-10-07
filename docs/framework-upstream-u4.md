# U4 upstream migration

Baseline audit: app `dc26f46`, framework `872698b`, own `wt-impl` worktrees.
The U1 plan is a proposal, so the table distinguishes current implementation from
partial supporting primitives. No navigation/activity, douyin or secure-store
files are changed by U4.

| U1 group | Status at baseline / evidence |
| --- | --- |
| 1 texture upload | Done: framework services helpers used by framework image pipeline |
| 2 window indexing | Done: framework windowed-list/windowed-rows, app visible-range re-export |
| 3 text environment/carets | Not moved: ReaderTextRow environment and reader/system-carets remain app |
| 4 progress indicator | Done: watch-ui WatchProgressIndicator + animation; app defaults retained |
| 5 back motion | Done: framework navigation BackMotion, screen imports it |
| 6 UTF-8 chunk | Done: framework bytes decodeUtf8Chunk; app dialect adapters remain |
| 7 ScrollEntries | Partial: framework indexed/windowed list primitives; component gestures/restoration still app |
| 8 RemoteImage | Done: framework image loader/component, app provider adapter |
| 9 SwipeCard | Not moved: app ui/SwipeCard.tsx |
| 10 DeleteConfirmDialog | Not moved: app ui/DeleteConfirmDialog.tsx |
| 11 UI text layout | Partial: framework text-layout sliced scheduling and text-wrap atlas wrapping exist; app ui/text-layout, reader/line-break, measured-text policies remain |
| 12 Compose scaling | Not moved at baseline; U4 moves unchanged math into text-compat |
| 13 activity/navigation state | Not moved: app navigation/activity-state, activity-navigation, route-activity; excluded for K23 |
| 14 ScrollRestoration | Not moved: app navigation/scroll-restoration |
| 15 restorable input | Not moved: app ui/modal-input uses existing host services |
| 16 startup trace/gate | Not moved at baseline; U4 moves mechanism into startup, phase names/tag remain app |
| 17 startup transition | Not moved: app startup-transition/StartupGate |
| 18 log redaction/file queue | Not moved: app logs/app-logger |
| 19 QR raster | Not moved: app QRCode/qr-pixels |
| 20 round QR layout | Not moved at baseline; U4 moves pure 233-unit preset + containment to watch-ui |
| 21 tiled images | Not moved: app TiledImage/image-tiles/image-preview |
| 22 managed cache | Not moved: app cache/managed, policy remains business-specific |
| 23 queue/history/autoscroll/autosave | All four remain app reader/progress-write-queue, notes/raw-text-history, reader/autoscroll, notes/draft-autosave |
| 24 lazy regexp | Partial: private helper in framework text-wrap; app helper still serves unmigrated UI/reader algorithms |
| 25 SQL pages/text/framing | Partial: framework sync-framing and byte codecs exist; app sql-pages/sql-text/StreamFrameConnection orchestration remains |

RS1/RS2 HTML parsing and K21/K22 XML/JSON/byte slicing also have framework
implementations (`html`, `html-slices`, `xml`, `json`, `bytes`). Their presence does
not make all of U1 #11/#25 complete. This audit describes local baseline sources,
not remote branches or device acceptance.

## Compatibility and ownership

- Font arithmetic, cache ordering and source/license attribution remain intact.
  Existing application oracle tests are unchanged. The framework also runs the
  real Compose Float-bit fixture directly. Application imports stay compatible.
- Round layout rectangles are numerically unchanged. ShareQr's separate layout
  and all QR encoding/scanning/payload behavior remain untouched.
- Startup trace/gate instances are generic. Application singleton lifetime, log
  tag `Startup`, phase names, default 3000 ms fallback, timer creation after ready,
  swallowed timer rejection, and lack of cancellation on readiness are preserved.
  Explicit framework dispose is new opt-in cleanup, unused by the legacy adapter.
- `tests/fixtures/upstream-u4` freezes baseline implementations; only the startup
  fixture's relative logger import is relocated. The differential tests compare
  random/cache-order font conversions, viewport/margin geometry, and startup
  messages/event order for ready, timeout and rejected timer paths. They do not
  import the new implementation from the oracle.
- Framework tests exercise default trace construction and actual services.delay
  dispatch/event settlement without injecting clock/transport into the gate.
- No component markup/style changes. CLI package build and framework style/XML
  checks remain required. No device commands or APK installation are authorized.

Device handoff: designated device owner should use the protected upgrade flow,
first compare home size to the approved density-2 reference, then verify default
and changed font scale on the Beian/reader text pages, QR title/status/action
positions, and cold-start content readiness/fallback logs. QR scanning and GPU
present timing remain device-only acceptance, not inferred from these host tests.

## Host verification

- App `bun run test`: 1227 pass, 0 fail (206 files), including isolated startup
  subprocess coverage; `bun run typecheck`: exit 0.
- Framework `bun run test`: exit 0, including new text/gate/geometry suites,
  existing JS/browser/host harnesses, and Cargo (103 pass, 4 ignored).
  `bun x tsc --noEmit`: exit 0.
- Final targeted geometry/style/XML run: 13 pass, 0 fail. Frozen oracle files
  verified against `git show dc26f46:<source>` (startup import relocation only).
- Required main CLI `build --target=android-watch --project=<app wt-impl>`:
  exit 0, including after pinning framework `ea152b1`; 99 pak entries,
  69,473,376 bytes, bytecode 1,640,477 bytes. No APK was created or installed.
- Device: PENDING; no ADB or device operations. These results establish host
  equivalence and packaging only, not visual or device performance acceptance.
