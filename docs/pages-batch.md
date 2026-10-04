# Remaining-page migration batch — 2026-09-04

Baseline: current dirty Android source at HEAD 0835b84cbc03b654bafde347862e734215502237; original diff fingerprint remains 87c601a6aa4ff5bf9feab97e72e5b51303cf9d17186c23b578b4d818464ff5ab.

## Implemented routes

- Home → standalone memos → detail/edit and actions (pin, folder selection, confirmed local deletion). Separate `memo_notes`/`memo_folders` tables preserve article annotations. Memo changes refresh the retained list after return.
- Home → RSS recommendations → group → prefilled native URL input → parse and add. All six original recommendation groups are recorded. Built-in Bilibili/Douyin entries currently open their websites; native media routes remain pending.
- Profile → settings → advanced; reading font size persists and affects actual reader layout. Unconnected media/cache/sync settings remain disabled and explicitly pending.
- Profile → about → introduction, privacy, agreement, licenses, contributors.
- Profile → developer contact → group QR and log privacy notice; actual log upload remains disabled.
- Filing footer → filing information → user-requested external browser.

All full pages share the app navigation stack and moving circular back mask. Android native browser service accepts HTTP(S), runs on the UI thread and reports missing handlers. Legal documents load from the existing backend with error/retry and stale-response protection.

## Verification scope

Bun tests cover memo CRUD/tombstones/hash, settings persistence and validation, malformed subscription rejection before insertion, and refresh with an already downloaded feed. Device results are recorded after the integrated APK is tested. Original screenshots: `artifacts/original-settings-pages.png`, `artifacts/original-about-pages.png`.

This batch is not full Android acceptance. Android v18 import, memo sync/conflicts, account/sync flows, reader presets, media controls, cache settings, log uploads and native Bilibili/Douyin remain open in `acceptance.md`. Pixel-perfect acceptance is recorded per exercised screen, not inferred from TSX or APK compilation.
