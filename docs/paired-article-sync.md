# Physical paired-phone article exchange

The isolated Android watch fixture exercises the production `RfcommLibraryListener`, `LibrarySyncSession`, SQL library repository and body file services. The phone runs an Android instrumentation protocol client over its existing secure Bluetooth bond. Its private service UUID cannot address the main WatchRSS listener.

The phone independently generates Chinese/emoji text plus 240,000 deterministic alphanumeric characters, encodes Android `JSONObject` JSON with `GZIPOutputStream`, hashes and splits the 180,598 compressed bytes into two chunks. It requests that the watch return the newly stored article in the same exchange. It verifies each returned chunk, the whole compressed body, byte count, exact decompressed text, independent/favorite/watch-later states and reading position. The watch independently checks durable export and cursor advancement from zero to 11 after the applied ACK, then removes fixture data.

The first fixture used an arbitrary article ID, which failed to select the exported article. Native `DefaultRssRepository.stableArticleId` uses the normalized URL SHA-256. The corrected fixture follows that rule. The failed phone log remains in `artifacts/article-peer-initial-failure.log`. No production behavior was changed to accommodate the test.

Evidence is collected by `scripts/verification/collect-article-peer-receipt.py` into `artifacts/article-peer-receipt.json`: matched phone/watch text hashes, APK hashes, runtime library identity, main application database/file preservation and phone test-package removal. Three newly created immutable body files (including the initial failed fixture) were removed after validating their content-addressed names against the archived bytes; the collector verifies they are absent. Type checking and Android Gradle builds are required. The main application executable is unchanged.

Limits: this proves a physical exchange with an Android protocol fixture, not the normal phone companion's UI/client. It is one deterministic article, not general synchronization or performance coverage. The pre-ACK cursor query does not independently timestamp receipt of the received-only ACK. IP upgrade, broader library modes, normal companion integration and visual/gesture acceptance remain separate requirements. Metadata hash parity is covered separately by native oracle fixtures; this client only exercises initial body selection.


A separate [IP bootstrap increment](ip-sync.md) now exercises the article exchange through authenticated WebSocket framing with an explicit ADB relay. It does not establish wireless LAN acceptance.
