# Note text conversion and live refresh

The memo text converter now follows native `watchPlainText`: selected HTML tag substitutions, Jsoup-compatible entity consumption, Markdown stripping, Kotlin whitespace trimming and line splitting. Titles preserve native UTF-16 truncation at 80 units. `entities` 7.0.1 is a direct dependency for the HTML name table, with a small compatibility layer for Jsoup's complete letter-then-digit name consumption and numeric zero/surrogate handling.

`scripts/reference/capture-note-text.py` extracts and executes the unchanged native Kotlin functions from `WatchNoteRepository.kt` with Jsoup 1.17.2. The fixture captures UTF-16 units before JSON/UTF-8 transport to preserve isolated surrogates. Its 73 cases cover HTML images/lists/tables, unknown tags, legacy and long entities, unknown names, numeric controls/invalid code points, Kotlin whitespace, line endings, Markdown and supplementary-character title truncation. Both plain text and title matched in Bun and in the actual Android QuickJS guest. Source/function hashes and execution scope are recorded in `tests/fixtures/note-text-native.json`.

New local saves and received notes use the converter. Existing stored plain-text fields are not rewritten. Repository input Markdown is preserved during sync, as in native code; local edits retain their existing newline normalization.

The notes list, detail screen and action screen now refresh on the application's note event. Query generations reject late responses after newer refreshes, edits or disposal. A remotely deleted note clears the detail data and dismisses obsolete folder/delete choices in the action screen. Native reference: `NotesActivity` observes note changes continuously and `NoteActionsActivity` observes note/folder state.

An isolated guest mounted the production `NoteDetailScreen` and sent three production-handler changes: initial title, updated title, tombstone. All three events completed without reported component errors and owned rows were removed. This does **not** prove visible refresh: the device's continuous-charging system warning covered the full-display screenshots. `artifacts/note-live-visual-status.json` explicitly records visual acceptance as unverified. No physical input was synthesized to dismiss the system warning.

Artifacts: `note-text-all-unit.log`, `note-text-typecheck.log`, `note-text-guest-kv.json`, `note-live-result.json`, screenshots, and `note-text-receipt.json`. Full paired-phone note exchange, note assets, large payloads, concurrent editing policy and visual/interaction parity remain pending.
