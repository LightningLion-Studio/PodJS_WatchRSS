# Bilibili UI source map

The parent app selects the RSS presentation when the built-in Bilibili channel has `useOriginalContent == false`. The PocketJS UI therefore follows these reachable Android sources:

- Feed: `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/bili/BiliRssFeedScreen.kt`. It uses a centered `哔哩哔哩 ⓘ` header and login state, a login pill only while logged out, then text-only cards with a two-line title and `作者：… · 播放 …` summary. The Android swipe actions are represented by the externally routed actions screen because `ScrollEntries` does not own horizontal swipe state.
- Channel information: `BiliChannelInfoScreen.kt`. The clickable `ⓘ` header opens this route, which exposes Settings, Login, Search, Watch Later, History, and Favorites with the same authentication gates as Android.
- Saved lists: `BiliListScreen.kt`. History and Watch Later use full-cover cards with title and author/progress or duration; Favorites first shows the real account folders and then their real resources.
- Detail: `Android_WatchRSS/app/src/main/java/com/lightningstudio/watchrss/ui/screen/bili/BiliRssDetailScreen.kt`. Its order is title, `作者：`, `简介：`, full-width poster/play card, then centered favorite and share actions.
- Login: `BiliLoginScreen.kt`. Its order is title, QR code, poll status, and refresh. PocketJS uses the shared round-safe QR composition with a 152px QR at 233px, keeps every rectangle inside the circular boundary, supports pull refresh and a visible refresh action, and cancels polling on cleanup.
- Search and results: `BiliSearchScreen.kt` and `BiliSearchResultScreen.kt`. Both begin with a centered title and native text input; search includes hot terms and results route video rows to detail.
- Comments and replies: `BiliCommentScreen.kt`, `BiliReplyDetailScreen.kt`, and `BiliCommentCard.kt`.
- Video actions: `BiliVideoActionsActivity.kt`. The reachable actions are favorite, watch later, share, and cancel. Favorite folder choice is required by the typed PocketJS API. Share opens a dedicated route containing a QR code for the real `bilibili.com/video/...` URL.
- Settings: `BiliSettingsActivity.kt` and `BiliSettingsScreen.kt`. The page preserves the actual Activity call: login status; conditionally shown original-content toggle and caption; conditionally shown background-playback toggle; logout; and conditionally enabled delete channel. Original-content state is stored at `watchrss.bili.original-content`; native media policy and channel deletion use callbacks in `BiliScreenProps.settings`. Deletion first opens an in-app confirmation view and only invokes the callback after confirmation.
- Player: `BiliPlayerScreen.kt`. Playback resolution is live and the route carries the typed `BiliPlayUrl`; the parent host owns video rendering and controls.

All dimensions in the TSX are logical pixels for the 233 logical-pixel round viewport (466 physical pixels at density 2).
