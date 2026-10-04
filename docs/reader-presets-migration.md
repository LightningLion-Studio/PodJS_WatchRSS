# Reader presets migration

## Verified data and scheduling layer

The watch's native `ReaderPresetActivity` selects phone-synchronized presets; it does not create or edit them. Its reachable controls are light/dark/automatic mode, light and dark preset selection (including dark follows light), fixed switching times, and sunrise/sunset based on the watch's location. The phone download prompt is a separate dialog.

`src/reader/preset.ts` now represents schema 2 body typography, category overrides, image/video background parameters and metadata. It decodes schema 1 with category typography enabled, matches native role defaults and normalization, and resolves explicit category scaling relative to body size. Face index and variation overrides apply independently of `useOwnFont`; only the asset ID follows that flag. Unsupported future schema versions are rejected.

`src/reader/preset-store.ts` stores selection and scheduling under `watchrss.reader-presets`. Initial seeding preserves legacy size and theme, creates the opposite theme at its default size, and does not repeat when any records exist, including tombstones. Selection updates retain raw preset payloads, unreadable records and future-version payloads. Invalid top-level persisted data fails without overwriting it. No phone synchronization ingestion is connected yet.

`src/reader/theme-schedule.ts` follows the native solar calculation, UTC-second truncation, event-specific timezone conversion, inclusive dark start, overnight/reversed intervals and equal-start behavior. Missing locations and polar cases fall back to fixed times. `SYSTEM` means the watch schedule, not Android's current UI theme.

There is one intentional malformed-input difference: absent/non-finite numeric layout fields receive finite defaults. Native `JSONObject.optDouble` without a fallback can produce NaN for absent fields, which then cannot be encoded. Raw stored records remain unchanged; decoding does not rewrite imported payloads. This does not change valid native schema-2 payloads.

## Evidence

- `scripts/reference/capture-theme-schedule.py` compiles the unmodified native `WatchReaderThemeSchedule.kt` and emits 348 JVM cases across 12 locations, leap dates, DST changes, quarter/half-hour zones, date-line offsets and polar conditions. All sunrise/sunset results match at minute precision.
- `scripts/reference/capture-reader-presets.py` compiles unmodified `ReaderPresetModels.kt`. Six fixtures exercise dark/light payloads, schema-1 semantics, font inheritance, category overrides, enum fallback and numeric bounds. Decoded fields and all five resolved typography roles match, allowing Kotlin Float versus JavaScript Double precision.
- Reference JSON fixtures retain the native source paths and SHA-256 values. The original Android worktree diff remains `17fbfdbe1bae93dc9e14eee7efc81dbbc896cb0f67ae9b69a51d6ca79130027f`.
- `bun test tests`: **181 passed**, 27,758 assertions, 35 files. The new two test files contribute 10 tests and 8,944 assertions. `bun run typecheck` passes. Logs: `artifacts/reader-presets-core-tests.log`, `artifacts/reader-presets-core-typecheck.log`.

## Connected watch UI and rendering

The production settings route now opens the preset selector: dark/light/automatic modes, separate selections, dark follows light, fixed start times, sunrise/sunset mode and the native phone-download QR destination. Selection and schedule changes persist without rewriting raw preset records. Android `input.time` uses a 24-hour TimePickerDialog; cancel returns null. The renderer resolves the active preset, solid background, body/category sizes, line heights, colors, supported bold slots, alignment and letter spacing. Layout cache keys include measurement-changing styles, and existing document anchors survive reflow. Light reader actions now use light surfaces and dark icons.

Automatic mode uses the watch's local clock and recalculates the active choice on the existing frame loop at one-minute intervals. A device test compares a controlled schedule against Java Calendar local time after restarting the reader. This verifies clock agreement and the selected result, not a long-duration observation across a real switching boundary. Fixed intervals and solar calculations retain the native-reference unit coverage above.

The old general font-size setting follows native behavior: it seeds initial presets, but does not mutate an already seeded active preset. The watch remains a selector; the phone editor is not reproduced as a watch editor.

`device.location` is implemented as a foreground, user-requested Android operation using the same permission pair and provider order as native. No GPS fix, permission acceptance/denial flow, or solar switching on real coordinates has been device-accepted. Tests do not grant permissions or inject locations.

## Validation and limitations

Final application tests: 182 passed, 27,766 assertions across 35 files; TypeScript passes. Framework service tests: 45 passed. The targeted device preset test passed, covering dropdown cancel/select, persistence, time cancel/confirm, QR return, light article styling and local-clock agreement. Full device regression passed 24/24 (22 application tests and two native time-input tests), with zero failures or skips, in 536.204 seconds. The published APK and installed watch APK both have SHA-256 `4a21a06a7651149140650973083c6e89f91f2366f9dbd3daca68736f1ec5b21a`. Exact identities, logs and scope are recorded in `artifacts/reader-presets-apk-receipt.json`.

Native screenshots come from the unchanged production ReaderPresetActivity in the isolated reference package. Three top views and automatic controls were captured successfully. The separate native popup window returned only transparent pixels despite PixelCopy success; its capture is explicitly invalid and the audited test is skipped. Its WindowInspector geometry is available, but it is not native visual evidence. See `artifacts/reader-presets-comparison.html` for raw images and comparison scope. Font rasterization, text layout and positions still differ; pixel identity is not claimed.

Still pending: phone preset/resource synchronization; imported font files, face/variation/italic synthesis; image/video backgrounds and their transforms; exact justified text, hyphenation and complex-script tracking; arbitrary custom accent tinting of image icons; applying presets to the native note/info/video surfaces; real location and physical acceptance. Background parameters are retained in the schema, but this renderer currently uses solid colors. Unknown/future records and invalid top-level data remain protected. Full migration remains incomplete.

## 手机同步接入（2026-09-14）

已接入 `syncReader` 的清单合并和字体/背景资源推拉，并通知现有界面刷新预设状态。主应用已部署；459 项应用测试、原生 JVM 对照及手表隔离资源续传/回读验证通过，手机只读读取主应用两条预设也通过。已有数据未改变。完整证据和仍未完成的预览、资源手机传输及实际字体/背景显示验收见 [reader-sync.md](reader-sync.md)。
