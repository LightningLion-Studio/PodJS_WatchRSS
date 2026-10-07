# DBG1 debug parity implementation and lead UI handoff

Branch: app/framework `impl/debug-parity`, based on app `7f532ee`, framework `561fad8`. No device operations. No signing credential file was read; packaging uses an untracked config with `android.signing` removed.

## C15 external ABI

`android.debugExternal` declares fully qualified activity aliases, receiver actions and provider authority. The framework CLI generates Java and a manifest into a separate directory outside packaged assets. Gradle includes that source/manifest only in debug (or explicitly debuggable verification release). The bridge implementation and exported components are absent from ordinary release DEX/manifest. The runtime also checks Android FLAG_DEBUGGABLE before dispatching bridge operations. The guest listener checks host buildInfo, and each WatchRSS action independently checks DebugGate.

WatchRSS components (prefix is `com.lightningstudio.watchrss`, app package remains `.podjs`):

- `DouyinDebugEntryActivity`: `com.lightningstudio.watchrss.debug.action.OPEN_DOUYIN`; enters existing immersive flow once login/feed are ready. `resume_aweme_id` selects a cached/feed item if present; otherwise existing entry fallback selects the first. RSS mode retains its existing feed path.
- `LlmSummaryActivity`: debug alias action `...debug.action.OPEN_LLM_SUMMARY`, positive integer `item_id`; starts the independent summary controller. No regular menu entry.
- `debug.DouyinPlaybackDebugReceiver`: action suffixes `ADVANCE_TO_NEXT_DOUYIN_VIDEO`, `FORCE_FAIL_NEXT_DOUYIN_VIDEO`, legacy `FORCE_FAIL_CURRENT_DOUYIN_VIDEO` (also poisons NEXT), `REPORT_DOUYIN_PLAYBACK_CONTEXT`, `IMPORT_DOUYIN_COOKIE` (`raw_cookie`). Context result: `activeAwemeId=...;nextAwemeId=...;inVideoFlow=true|false`. Import codes: 0/ok, 1/missing_cookie, 2/apply_failed; raw cookie and backend exception are never logged or echoed.
- `debug.DebugLogProvider`, authority `com.lightningstudio.watchrss.podjs.debuglog`: dump defaults to bounded, redacted in-memory logs (400 entries / 50k characters). `--clear` clears that buffer only and prints `DebugLogBuffer cleared.`. `--douyin-playback` takes precedence and prints `DOUYIN_PLAYBACK_DEBUG` plus real active/next/flow context. Outside a flow prints `state=unavailable`.

**DBG2 C15 mapping (app a32a129 / framework 22f0cc0 baseline):** the dump now samples the current debug-only playback owner on demand. It reports these separately:

| Field | Actual source / meaning | Remaining difference |
| --- | --- | --- |
| ManagedCache | fresh framework FileCache disk accounting, per-bucket bytes, pin count, worker/queue counts | disk bytes, not RAM |
| DL | managed file workers, queued requests, retained download handles, leased paths | no wire-byte progress; workers also include cache hits/stat/validation |
| M3 | BiliPreviewCache validated in-memory index, complete/partial indexed bytes and active/queued jobs | **Bili scope**; partial offset is committed `.part` progress; stale index may outlive eviction |
| DouyinPreviewDL | unavailable | no native Douyin preview-download/byte-array producer in PodJS |
| RAM | unavailable | targetBufferBytes is an ExoPlayer allocation **budget**, not measured resident or preview RAM |
| VideoSessions / Slots | `media.video.sessions` host capabilities/states + pool active/standby roles, prepared first frame and generation | legacy/fallback/unmounted/stale owners remain unavailable; unused slots are unbound; K11/K16 renderer threads are unrelated |
| Queue / Quarantined | current DouyinPlaybackQueue item count/index/generation and its actual removed-ID set | native quarantine reason, failureCount and lastFailedAt are not recorded; unavailable |
| injectedFaults | DBG1 poison IDs | separate from actual queue quarantine |

Native reference: `DouyinPlaybackDebugOverlay.kt` (DL/RAM/slots text),
`DouyinPlaybackPreviewCache.kt:769` (in-memory bytes/download registrations),
`DouyinImmersiveScreen.kt:1330` (reason/count/timestamp records), and
`DouyinFeedViewModel.kt` (session exclusion set). No new quarantine behavior or
preview downloader was introduced. No raw URLs, headers, source hashes or errors
are echoed. Release/inactive dump calls perform no new diagnostic reads; slot
binding is gated by `application.buildInfo().debugBuild`, disposed with the active
screen. Owner changes during asynchronous reads return unavailable. Sources are
not sampled atomically across services; no device parity is claimed. The receiver
REPORT response retains the native active/next/inVideoFlow ABI; the expanded
metrics are returned by the provider playback dump.

Bridge requests are in-memory, max 32 pending, four-second deadlines; primitive intent extras only, max 32 fields / 16k characters each. Cold activity requests wait for the content listener. Broadcasts/provider requests with no mounted guest terminate unavailable/timeout; they do not launch guest or bypass onboarding. Owner disposal unsubscribes and finishes pending replies; expired events are ignored by guest. Provider query/insert/update/delete retain native empty/no-op behavior. Cookie network import can exceed the bridge deadline; timeout does not imply the underlying import was rolled back.

## C16 summary logic / placeholder

Native sources: `LlmSummaryActivity.kt`, `ui/viewmodel/LlmSummaryViewModel.kt`, `ui/screen/rss/LlmSummaryScreen.kt`. Activity reads `item_id`, calls prepareAndStart only when >0. No normal caller was found. New debug route `debug-summary` checks the build gate at navigation, restoration and component mount. `DebugSummary` uses production `AppServices.createSummary`: original-source wait, account refresh, usage recording, error retry, and disposal cancellation are the existing summary pipeline. Placeholder shows state/content/token text, tap error to retry. Lead owns final scrolling/layout.

Native UI specification: black WatchSurface (no vignette), crown-scrolling column, safe padding 18dp, title top gap 6dp, row AutoAwesome 16dp + gap 6dp + title “AI 总结” (titleSmall/onSurface). Generating spinner 14dp, stroke 1.5dp, gap 8dp. Section gap 8dp; state text indent 10dp. Idle “准备中...”; waiting “原文还在加载，准备好后会自动开始总结。”; generating “正在生成总结...”. Content card radius 12dp, surfaceVariant, padding 12dp horizontal / 10dp vertical, bodyMedium line height 20sp. Optional token card radius 10dp, surfaceVariant alpha .6, padding 12/8dp, label “Token 用量”, 4dp label/value gap. Error card radius 12dp, #FF6B6B alpha .12, centered “生成失败” in #FF6B6B, 4dp gap to bodySmall explanation; “重试” pill below 8dp gap. Bottom spacer hey_multiple_item_height. Keep the application reader-background policy when lead finalizes any reading treatment.

## C17 TTS logic / placeholder controls

`TtsConfigStore.updateDebugField` persists model/voiceId/baseUrl independently, allowing incomplete configurations like native per-field updates. `setDebugApiKey` saves or clears per-engine keys in secure storage; no plaintext key is placed in KV. Both enforce host debug gate. `DebugTts.fields/update/setApiKey` exposes this to the existing debug tools placeholder rows. Key entry starts empty, never prefills a stored secret; status stays masked. Existing phone-config validation/release speed settings are unchanged.

Native sources: `TtsSettingsActivity.kt`, `ui/viewmodel/TtsSettingsViewModel.kt`, `ui/screen/rss/TtsSettingsScreen.kt`. **Audit correction:** current native detailed screen displays voice/model and key status and directs edits to the phone; its VM exposes updateModel/updateVoiceId/updateBaseUrl/setApiKey. There is no native full wrist text-editor layout to copy. The added wrist editor fields implement the explicitly requested capability, not a claim that native has those exact text controls.

Lead UI specification: debug title “朗读语音源”; release title “朗读语速”; pure black/crown scroll/safe padding 18dp. “当前引擎” pill opens picker: 本地 TTS / 应用默认语音 / MiniMax / Azure / 豆包, selected ✓. Section gap 8dp; description indent 10dp/top 4dp. “应用默认语音” account status; for keyed engines “音色 / 模型” (voice or 默认), “API Key” (已配置 / 未配置), phone-edit hint. “语速” minus/plus, .1 step bounded .5–2.0. “测试连接” / “正在测试...”; success #4CAF50 and latency ms; failure #FF6B6B. “手机扫码配置语音” retained. Text uses existing theme onSurface/onSurfaceVariant and SettingsHeader/WatchSettingsPillRow styles. Lead should replace the provisional model/voice/baseURL/key input rows with final UI without exposing stored key values.

## Required device follow-up (lead dispatch only)

Install debug via protected acceptance upgrade; first compare home dimensions at density 2 with K8 reference. Test cold/warm OPEN_DOUYIN with existing login, resume ID and RSS mode; ordered context/fault broadcasts with a controlled clip; provider dump/clear; summary invalid/valid item, original-load wait, retry, token toggle and back cancellation; TTS field save/restart/key clear in isolated fixture account. Do not import cookies or modify real account settings without separate authorization. For release, verify external components absent/not resolvable and debug restored routes rejected. Device, backend, voice/audio and visual acceptance remain PENDING.
