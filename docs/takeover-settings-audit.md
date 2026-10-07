# T6b SettingsRepository key audit

Native source baseline: recovery-40 8d65e148. All 27 fixed keys + 2 dynamic prefixes mapped.

| Native key | PodJS target |
|---|---|
| `cache_limit_bytes` | `watchrss.settings.cacheLimitMb` |
| `oobe_seen_version` | `watchrss.onboarding.oobeSeenVersion` |
| `reading_theme_dark` | `watchrss.reader-presets.selection.mode (only absent explicit reader mode)` |
| `reading_font_size_sp` | `watchrss.settings.fontSizeSp` |
| `reader_auto_scroll_enabled` | `watchrss.settings.readerAutoStart` |
| `reader_auto_scroll_lines_per_second` | `watchrss.settings.readerScrollSpeed` |
| `share_use_system` | `watchrss.settings.shareUseSystem` |
| `phone_connection_enabled` | `watchrss.settings.phoneConnectionEnabled` |
| `sync_media_keep_alive_enabled` | `watchrss.settings.syncMediaKeepAlive` |
| `media_volume_control_enabled` | `watchrss.settings.mediaVolumeControl` |
| `media_volume_guard_enabled` | `watchrss.settings.mediaVolumeGuard` |
| `media_playback_start_volume_limit_percent` | `watchrss.settings.playbackStartVolumeLimit (-1=null; absent guard=true =>10)` |
| `rss_inline_image_prefetch_mode` | `watchrss.settings.mediaCacheMode` |
| `llm_provider` | `watchrss.settings.llmProvider` |
| `llm_model` | `watchrss.settings.llmModel` |
| `llm_base_url` | `watchrss.settings.llmBaseUrl` |
| `llm_system_prompt` | `watchrss.settings.llmSystemPrompt` |
| `llm_enabled` | `watchrss.settings.llmEnabled` |
| `llm_auto_summarize` | `watchrss.settings.llmAutoSummarize` |
| `llm_show_token_usage` | `watchrss.settings.llmShowTokenUsage` |
| `llm_prompt_preset` | `watchrss.settings.llmPromptPreset (+1)` |
| `tts_engine` | `watchrss.tts.config.v1.engine (empty/absent => local)` |
| `tts_model` | `watchrss.tts.config.v1.model` |
| `tts_voice_id` | `watchrss.tts.config.v1.voiceId` |
| `tts_speed` | `watchrss.settings.speechRate + watchrss.tts.config.v1.speed` |
| `tts_base_url` | `watchrss.tts.config.v1.baseUrl` |
| `privacy_policy_agreed_version` | `watchrss.onboarding.privacyPolicyAgreedVersion` |
| `temp_original_mode_hint_attempts_<channelId>` | `watchrss.temporary-original-hints.v1.<channelId>.attempts` |
| `temp_original_mode_hint_last_toast_<channelId>` | `watchrss.temporary-original-hints.v1.<channelId>.lastToast` |

Phone defaults true, old settings remain valid. The new setting gates automatic Bluetooth and IP sync and has a settings toggle. Native baseline only references this flag in SettingsRepository/SettingsViewModel; it has no active runtime reader. PodJS now honors the persisted user choice in its listeners.

Native LLM provider/model/base URL/system prompt have no runtime consumer in this baseline; matching stored fields remain readable/writable in SettingsStore without changing server summary routing. LLM secret prefs are outside SettingsRepository and remain fail-closed if unsupported.

Original-mode hints retain the native twelve-hour window, third-enable threshold and last-toast cooldown; wired to the temporary reader original toggle using the native message.

Schemas remain validated. Unknown keys/unknown user files block ACTIVE. Converter versions increase to stores-3/files-3; earlier incomplete receipts are rejected rather than reused with changed semantics.
