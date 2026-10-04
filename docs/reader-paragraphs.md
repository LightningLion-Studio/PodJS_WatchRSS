# Native paragraph rendering

The PodJS development application now retains Android paragraph context from layout through texture rendering. Automatic hyphenation, inter-word justification, centered lines, bidirectional context and Compose text-motion paint settings are passed to the native layout service. Rasterization draws a slice of the same complete StaticLayout instead of independently reshaping each line. Stored source text and UTF-16 source offsets remain unchanged: generated hyphens are rendering output.

The runtime shares a bounded paragraph cache across layout and per-line raster calls. Its key includes typeface identity, locale and layout/paint options; the worker clears it when the owning services close. The cache is bounded to 32 entries and 262144 UTF-16 units. Current tests prove reuse, entry eviction and clearing; the large-text unit limit and every cancellation/locale/font replacement combination have not all been stress-tested.

## Verified comparison

The installed native reference APK supplies its actual preview StaticLayout builder and Compose paragraph implementation. A 144-case native comparison checked 588 lines and 8300 caret positions, with exact line geometry and raster bytes. Eighteen cases changed wrapping when automatic hyphenation was enabled. Cases cover preview and Compose paint policies, three alignments, hyphenation, mixed scripts, emoji, combining characters, empty/trailing lines and decorations.

A separate physical-watch fixture mounted production ReaderPreviewScreen and ReaderBody. Twelve stages covered start, center, justify, hyphenation, justification plus hyphenation, and animated text rendering in both screens. All corresponding pixels match native: preview comparison covers physical y=80..465, excluding the status label; body comparison covers the entire 466×466 texture. Rendering waits until text work drains. Preset storage remains unchanged and all text resources release after unmount. No synthetic input is used. This does not establish physical gesture acceptance or every arbitrary preset, font and article.

This test exposed a build defect: pass 1 ignored TSX components imported through workspace package names, so the text texture's absolute-position class could be absent while its component was bundled by pass 2. The source resolver now follows resolvable TypeScript package exports, preserving the existing framework-variant resolution. The preview label also declares its 11 px font dependency directly. The initial failed frames were retained separately from the passing reader-paragraph-* evidence.

## Deployment and data

The deployed package is com.lightningstudio.watchrss.podjs, version 0.1.0-dev / code 1, with its existing WatchRSS label. APK SHA-256: cd5e91198d89c0ee7fff237201bc80a09d0c885173a9fbffc3bb5ebe5b6c78f8. Native shared libraries match the previous deployment; paragraph changes are in Java, framework transport/rendering and application layout.

The full app suite passed 479 tests and type checking. SDK services and text lifecycle checks passed 36 tests. After replacement, the actual main process passed authenticated read-only queries and seven preview requests using an explicitly recorded ADB relay. This is not Wi-Fi LAN verification. The 30 application tables and 188 protected non-database files match the pre-update snapshot. WorkManager's last-force-stop timestamp is the sole permitted non-database change. Owned test packages and relays were removed, Wi-Fi settings preserved, and the main application resumed.

Evidence: [deployment receipt](../artifacts/reader-paragraph-deployment-receipt.json), [native paragraph proof](../artifacts/reader-paragraph-native-proof.json), [UI proof](../artifacts/reader-paragraph-ui-proof.json), and [receipt verifier](../scripts/verification/collect-reader-paragraph-receipt.py).

Complete migration remains open, including physical gestures, native companion UI workflows, actual Wi-Fi/discovery, broader media/font/EXIF/large-file inputs, and long-duration performance and power behavior. These bounded checks must not be reported as complete feature or visual parity.
