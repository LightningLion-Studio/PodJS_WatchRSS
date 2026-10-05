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

## C11 comments (2026-10-04)

`CommentScreen.tsx` follows the two native comment Screens and `BiliCommentCard` at density 2:
64dp fixed app bar; horizontal safe padding 18dp; list gap 8dp; card radius 16dp/padding 12dp;
avatar 36dp/crop; text body 17sp/21sp, author bold 14sp/17sp, metadata 12sp/14sp;
20sp inline emotes; pictures 100dp boxes with 8dp trailing padding and horizontal scrolling.
Uses Watch dark colors (#0b1211, #1c1f21, #23272a, #f5f5f5, #b6b6b6, #ff6026),
VIP nickname override, UP and is_up_top badges. Names/body are measured with rendering font slots.
Links stay literal and mentions blue, without external navigation, matching CommentRichText.

`bili/comments.ts` owns next vs pn pagination, initial pins, root and retry/refresh/disposal.
The native SDK's comment endpoints are unsigned and omit sort/mode: do not add WBI or a login gate.
ReplyPagingSource continues until an empty page even if the reply cursor says end.
Root is connected explicitly here because the current native ViewModel does not transfer its paging source's root.
Top/regular duplicate rpid is retained once (pin first). Repeated main cursors stop instead of looping.
Error text is native “加载失败: …”; tapping it retries. A “加载更多” row supplements settled-range prefetch.
Reply cards are read-only; only main comment cards navigate, using rpid rather than comment.root.

Verification is local contract/component tests only. Font rasterization, inherited system font scale,
physical scrolling/crown, round-screen clipping, real remote images and live API behavior still need device acceptance.
