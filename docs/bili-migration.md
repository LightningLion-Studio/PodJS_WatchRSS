# Bilibili shared-service migration

`src/bili` ports the bounded network/data contract used by the Android `sdk/bili` module. It contains no Android or UI business logic. Consumers construct a client with an injected `BiliTransport`; authenticated use also requires a `BiliSecureStore`. The service never writes cookies to ordinary preferences and never logs them.

`getLoginState()` reports `anonymous` or `authenticated` from the presence of a real `SESSDATA` cookie. WBI signing keys are cached separately from the login session: public nav responses may return usable keys together with API code `-101`, and those keys enable anonymous feed/search/playback without creating a fake account session.

The transport decoder handles complete UTF-8, including four-byte code points found in real search results. A prior three-byte-only decoder corrupted otherwise valid HTTP 200 JSON containing emoji/non-BMP text and surfaced a misleading `invalid_json` error; this did not indicate a login or risk-control requirement.

Implemented contracts:

- web QR creation, one-shot polling, bounded polling with cancellation, secure cookie/refresh-token persistence, and WBI key refresh;
- persisted-session restoration and the web cookie-refresh lifecycle: refresh check, RSA correspond path, refresh-CSRF extraction, cookie/token replacement, old-token confirmation, and WBI refresh;
- WBI-signed recommendation feed, hot search and combined video/user/media search;
- video detail/relation and DASH or MP4 playback resolution (including the original legacy MP4 fallback);
- favorite-folder/resource lists, top-level comments and reply pages;
- history and watch-later list reads, plus explicit like/unlike, coin, triple, favorite-folder, add-to-watch-later, and playback-history report mutations with CSRF, Origin, and video Referer headers.
- local playback resume records and checkpoint coordination matching Android: five-second local-save steps, one ready report, 120-second tick reports, forced pause/error checkpoints, and ended reporting followed by local-progress removal.

The watch player now requests the same MP4 profile as native `BiliRepository.resolvePlaybackSource` (`qn=32`, `fnval=1`, `platform=html5`). A WBI response with no usable `durl` or DASH video retries the legacy endpoint, including the voucher-only response covered by the native SDK test. An API error does not silently trigger that retry. For a multi-entry `durl` response, playback uses the first URL, matching the native player; `durl` takes precedence if DASH is also present. DASH handling remains available for a DASH-only response. This is request/selection parity, not proof of successful playback against the live service.

Remote mutations occur only when their explicit client methods are invoked; rendering a page does not post interactions. Missing login, CSRF, WBI identity, identifiers, or secure storage produces a typed `BiliError`; the client does not return placeholder successes. Tests use sanitized queued responses and perform no remote requests.

Runtime integration in `src/media-services.ts` adapts streamed native HTTP files and platform secure storage. `QrLoginRequest` returns the actual QR payload URL; `src/ui/QRCode.tsx` encodes it to a single GPU texture. An OWW242 capture has been independently decoded to the official Bilibili account URL.

Cookie refresh uses the production `BiliRsaOaepSha256` adapter in `src/media-services.ts`. Its exact operation is RSA encryption with the exported Bilibili X.509 PEM public key, OAEP digest SHA-256, MGF1 digest SHA-256, empty label, and plaintext UTF-8 bytes of `refresh_<timestamp>`. It returns raw RSA ciphertext bytes, which the client lower-case hex encodes into `/correspond/1/<hex>`. The Android host exposes this under `crypto.basic` as `crypto.rsaOaepSha256`. On OWW242, `tests/runtime-bili-rsa` called the production host operation with an isolated test key; OpenSSL decrypted the returned 256-byte ciphertext to exactly `refresh_1700000000123`. The test application was uninstalled afterward. This proves the host cryptography and bridge, while a real account's complete cookie refresh remains unverified.

Not yet migrated: buvid activation/web-ticket repair, media-byte caching, removing watch-later entries, comment posting/liking, danmaku, creator/channel pages, and live/video-download behavior. These remain explicit omissions rather than simulated results.
