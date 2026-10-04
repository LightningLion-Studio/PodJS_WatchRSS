# Reader image and video backgrounds

The production article and live preview render reader asset backgrounds through the shared PodJS scene-media API. The watch variant is preferred for images; the master is the still-image fallback. Video uses the prepared watch clip and its watchPoster/master still. Missing clips use the still image; corrupt video retains its poster. Trim metadata is not reapplied to an already prepared clip, matching the native watch path.

Geometry includes crop/fit/fill, zoom, focus and rotation. Color processing includes brightness, saturation, base color and overlay. Blur follows Android-version-specific native paths. The preview freezes both preset and background resources during resource handoff. The resource revision refreshes changed files; appearance changes retain the video player and stable scene texture. Reader content remains above the background within normal scene clipping.

Video is independently muted and pauses while inactive or while the runtime is backgrounded. It does not change system volume. The underlying TextureView is noninteractive and hidden before decoded frames are presented through the scene. Disposal frees the player, bitmap, renderer and texture; late decode results cannot revive disposed owners. No per-frame guest RGBA payload or temporary image files are used.

## Bounded physical-watch verification

On OWW242 / Android 11, the owned verification app loads the installed native reference APK read-only. It invokes the actual native geometry, color and blur routines: 192 geometry cases, 49 color matrices, and four intrinsic blur cases match exactly; six unsafe paths are rejected.

Five full 466 × 466 background frames—crop, fit, rotation/color transform, blur, and missing-image fallback—are compared with the actual native Compose background composable running in the same owned fixture activity. Every case has zero changed pixels (217,156 pixels per case), enforced by instrumentation assertions and independently rechecked from PNGs. Rendering the hardware plane at actual viewport dimensions and rounding the media plane to native integer dimensions are necessary for this result.

A local H264 clip has changing captured frames. Style and speed changes, inactive pause/resume, host lifecycle pause/resume and nonloop completion preserve owner, texture and player generation. A broken clip retains its poster. The production preview retains its image during handoff with zero changed content pixels, applies a replacement image afterward, and the article renders the selected image. Preset storage is unchanged and all native media sessions and guest text resources are released after fixture exit. No synthetic mouse, keyboard or gesture input is used.

The application suite passes 476 tests; SDK services pass 30, isolated media lifecycle tests pass two, existing text lifecycle tests pass three, and core passes 154. The integrated Rust workspace and unchanged GPU decoder checks pass. TypeScript checking and both-ABI runtime/APK builds pass.

## Deployment and scope

The current deployment is recorded in `artifacts/reader-background-deployment-receipt.json`; its collector verifies the installed hash, bundled JavaScript/resources, native libraries against the verified fixture, source hashes, captures, read-only physical-phone probe, data preservation and cleanup. Main APK SHA-256: `4724c51fef3fb18a42680f99c23b891617e3a15cd9f02dc86620066fdab822e6`. Original package name, WatchRSS label and 0.1.0-dev / code 1 are retained. Historical receipts describe their own builds.

The phone probe uses an explicitly labelled temporary ADB relay, including seven live-preview messages. It does not demonstrate normal wireless transport or renderable asset transfer from the physical phone. The stopped data audit must retain all 30 application tables and 188 protected non-database files; only WorkManager's last-force-stop timestamp may change. The receipt also verifies temporary-app/relay cleanup and unchanged Wi-Fi/location grants.

At the time of that deployment, EXIF orientation, large-image sampling parity, video filter pixel equivalence, API 31+ RenderEffect qualification, HDR/video formats, sustained performance and power, native companion UI acceptance and Wi-Fi discovery/transport, arbitrary presets/fonts/scales, broader native article comparison and physical gesture/visual acceptance were open. These results establish the listed cases, not full migration completion.

Subsequent physical-phone Bluetooth resource transfer, disconnect/resume and received-media rendering are covered in [reader-resource-transfer.md](reader-resource-transfer.md). The background receipt above remains historical.

## 2026-09-25 EXIF orientation follow-up

The Android image service now reads JPEG EXIF orientation for whole-image and region decoding. It reports displayed source dimensions, maps requested displayed tiles back to raw image coordinates, and rotates or mirrors decoded pixels before handing them to the renderer. The change covers all eight EXIF orientation values, including the four that exchange width and height. On OWW242 / Android 11, the isolated `PodImageServicesTest` suite passed 7/7 tests; its four-color JPEG fixture checks displayed corners in the overview and four individual tiles for every orientation. The main app was rebuilt with this runtime and installed as `artifacts/watchrss-podjs-exif.apk`. The archived and installed APK SHA-256 are both `d9631de6144082e92ce5ed54f8dbf54284b5a50d59cbc1c1dbd26791b4fd325c`. The APK ZIP passed `testzip`, and its largest local-entry gap was 9,135 bytes.

The main app resumed with no recent PodJS/AndroidRuntime error. A stopped-app comparison before and after installation found identical row counts and content hashes in all 33 SQLite tables; both copies had `quick_check=ok` and zero foreign-key violations. [EXIF receipt](../artifacts/reader-exif-receipt.json) records the hashes and test boundary. This is orientation behavior evidence, not a pixel comparison with Coil on the same image. Large-image sampling parity, physical article/background visual acceptance, and the other previously listed gaps remain open.

The isolated native reference package subsequently used the production Coil dependency on the same 64×32 four-quadrant JPEG construction. Coil displayed the expected width, height and all four quadrant colors for each of the eight orientation tags on OWW242 (`OK (1 test)`). The PodJS image-service test was extended to check each quadrant again with `sampleSize=2`; all seven image-service tests still pass. Both tests then recorded the complete full-size RGBA output. For each orientation, the input JPEG SHA-256 and every decoded RGBA byte match Coil exactly; see the [pixel comparison](../artifacts/reader-exif-pixel-comparison.json). This proves exact full-size decoding for this synthetic fixture, but not Coil-equivalent sampling for arbitrary large images or visual parity in the rendered reader.

The native fullscreen preview is a different path: `RssImageLoader` keeps the raw EXIF orientation. The PodJS fullscreen viewer now follows that behavior, while article images and backgrounds retain the Coil-compatible orientation. The isolated native test and deployed PodJS build are recorded in [reader-migration.md](reader-migration.md) and its [receipt](../artifacts/reader-exif-preview-receipt.json).

The fullscreen JPEG color path also follows native `RGB_565`; the eight tagged synthetic inputs and full-size decoded RGBA outputs match byte-for-byte. See the [later fullscreen receipt](../artifacts/reader-exif-rgb565-receipt.json). This does not change article/background rendering or close large-image and physical display parity.
