# Douyin UI source map

This migration follows the current Android implementation in `Android_WatchRSS`:

- `DouyinEntryActivity` and `DouyinImmersiveScreen.DouyinTitlePage`: channel title, refresh state, upward entry into the video flow, history and settings entry points.
- `ui/screen/douyin/DouyinRssFeedScreen`: login empty state, feed cards, refresh/load-more behavior, author and like summaries.
- `ui/screen/douyin/DouyinLoginScreen` and `DouyinCookieInputDialog`: QR login presentation and manual Cookie input.
- `DouyinDetailActivity`: title, author, body, cover/video card and unavailable playback state.
- `ui/screen/douyin/DouyinHistoryScreen`: local-history heading, clear action, rows and empty state.
- `DouyinVideoActionsActivity`: favorite, watch later, share and cancel ordering. Favorite and watch-later use the same local saved-item semantics through `DouyinClient`; share renders the real canonical Douyin video URL as an on-watch QR code.
- `DouyinSettingsActivity` plus `BiliSettingsScreen`: login status, original-content/background-playback rows, logout and delete-channel actions.
- `DouyinPlayerActivity` and `DouyinImmersiveScreen`: native playback ownership and playback controls.

Current runtime boundaries are surfaced in the UI instead of simulated. The login card calls the injected `onRequestQrLogin` host entry, which opens the official Douyin WebView flow; a QR image can still be supplied by the host through `loginQrImage`, and manual Cookie input uses the injected native IME. The login page itself does not claim success: the host returns the captured Cookie, and the root applies and verifies it through `DouyinClient`. Favorite and watch-later persist through the shared local saved-item store. Original-content and background-playback switches delegate persistence to the root settings bindings, and channel deletion uses an explicit in-page confirmation before calling the root deletion callback. Playback URLs are resolved by the Douyin service, then handed to the host through `onPlay`; this module never creates a media surface or navigation stack. Remote cover and note images use `RemoteImage` so HTTP URLs are downloaded, decoded and uploaded as native textures rather than passed to the asset-only `Image` component.

The entry and feed screens share one bounded feed snapshot keyed by the `DouyinClient` instance, capped at 40 items. Entry prefetch therefore becomes the feed's initial batch, and returning between routes preserves it. Only the visible refresh and load-more actions issue another feed request. Dynamic feed/history titles and summaries are explicitly measured with CJK full-width and Latin half-width metrics, then clipped to the same one/two-line limits as the Android cards. Remote Douyin media receives only the exported public User-Agent and Referer headers; the user's Cookie is never forwarded to a cover-image host.

Detail headings use the narrower round-screen title width, explicit one-to-three-line layout and a height derived from the measured lines. Playback affordances use the bundled `play-circle.svg`; the UI does not depend on optional Unicode arrow or media-control glyphs.
