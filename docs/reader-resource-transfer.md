# Physical-phone reader resource transfer

The owned physical-phone and watch fixtures exercise the production WatchRSS foreground sync listener, persistent library session, reader manifest/resource dispatcher, filesystem adapter, live preview and native scene renderer. The phone connects with an actual bonded BluetoothSocket to the native service UUID. Resource bytes travel through RFCOMM; ADB launches/observes the tests and retrieves evidence, but does not forward the resource transport.

The phone first checks the isolated watch database identity and refuses resource writes to another identity. The main application is stopped while the owned listener is active. Only the fixture's database and resource directories receive test data; the original application's files are snapshotted while stopped and compared byte for byte before it is resumed.

## Protocol and rendering coverage

The phone sends a subset CJK serif font, a 720 × 640 PNG larger than one native 1 MiB chunk, a local H264 video master/watch clip and a poster. It follows the native phone `ReaderPresetSyncPayload` fields, version 11, base64 chunk payloads and SHA-256 checks. This is an independently implemented protocol test client, not automation of the native companion UI.

The sequence verifies the missing-resource manifest, font upload, actual font changes in production preview, image handoff, duplicate first chunk, a real socket disconnect, a new persistent connection, continuation from the next chunk, image preview, and video playback. During the interrupted image transfer the complete target remains absent, the partial file contains exactly 1 MiB, and the displayed preview content stays pixel-identical. Every complete received file is independently hashed on the watch and compared with the physical phone's source. The phone then pulls every resource back and compares every byte and each returned chunk hash.

The watch observes actual preview textures and native player state. Changed font/image pixels and advancing video frames are required. Stopping the preview releases all media owners, native media sessions and active/queued/cached text resources. No synthetic touch, mouse, keyboard or gesture input is used. These checks cover the listed resources and display region, not arbitrary formats or physical visual acceptance.

## Preset preservation fix

The first end-to-end run exposed a persistence issue: merging only font/background metadata replaced every unchanged legacy preset record with its wire-envelope representation. The preset meaning survived, but unrelated stored records were rewritten.

`ReaderPresetStore.mergeManifest` now retains the original representation of unchanged preset entities and saves new wire entities only for actual changes. This also preserves unrelated records when another preset is updated. The regression test fails before the fix and passes afterward. The full application suite passes 477 tests, and the physical-watch observer checks that records, selection and schedule remain unchanged across resource import and preview.

## Evidence and remaining acceptance

`artifacts/reader-transfer-deployment-receipt.json` binds the deployed build, source hashes, APKs, phone and watch proofs, image hashes, regression results and cleanup. `scripts/verification/collect-reader-transfer-receipt.py` independently checks the recorded conditions. The test commands select `ReaderTransferPhoneTest` on the phone and `ReaderTransferUiTest` on the owned watch package. The phone font's source, subset tool/version and hashes are recorded in `reader-transfer-font-provenance.json`; its notice/license accompany the test asset.

The production fix is installed as WatchRSS 0.1.0-dev / code 1, SHA-256 `acc7e95e0a2f8207bff53faaf6d7364e1117687e0d3111dc968c0661aa2d79b9`. During isolated testing all 191 original application files and all 30 application tables stayed identical. The post-deployment receipt separately verifies the original tables and protected files, permissions, observers and cleanup.

The final production read-only compatibility probe is separate and explicitly uses an ADB IP relay. It does not replace the direct Bluetooth resource-transfer evidence. Historical font/background native pixel proofs remain bounded to their documented cases; the runtime source and native libraries are checked against that deployment.

Still open: native companion UI acceptance, Wi-Fi LAN and automatic network discovery, all asset formats/sizes, EXIF and large-image decoding parity, video-effect pixel comparison, sustained power/performance, broader article layout and physical gestures. The full migration remains incomplete.
