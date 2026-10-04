# Standalone notes migration

The PodJS notes implementation is independent of the existing `notes` table, which stores annotations attached to RSS articles. `initializeMemoSchema()` creates `memo_notes`, `memo_folders`, and their indexes in one dedicated transaction. It does not change shared schema files or existing tables.

`memo_notes` mirrors the watch app's durable identity and sync fields: UUID `note_id`, folder identity, raw Markdown, plain-text projection, content/base hashes, base Markdown, pin state, timestamps, modifying device, and deletion tombstones. Deletes keep the row and identity for a future phone/watch merge. The current implementation performs local SQLite persistence only; cloud/Bluetooth synchronization and importing rows from Android Room are future integration work.

The root navigation contract is deliberately callback based:

- `NotesListScreen`: `onOpenNote(noteId)`, `onCreateNote()`, and `onOpenActions(noteId)`.
- `NoteDetailScreen`: accepts an optional `noteId`, uses the injected native text-input function for create/edit, and calls `onBack()` after a cancelled empty create.
- `NoteActionsScreen`: accepts `noteId`, owns folder selection and delete confirmation, and calls `onDone()` after an action.

The parent should retain the circular back gesture and screen stack. It can construct one `MemoRepository` over the app SQLite adapter, call `initialize()` during service startup, and pass the repository plus `textInput.prompt(...).result` into these screens.

The list now shows the native phone-edit/sync prompt in both empty and populated states. Holding a note row opens its actions using the current scroll offset; a normal tap opens the note. The prompt uses the shared phone-download QR dialog. This interaction has source, coordinate-test and build evidence only; physical-watch input and screenshot parity remain open.

2026-09-26 update: OWW242 isolated-app tests now cover the populated list, short tap, long press, and phone-download dialog. A host touch-snapshot queue fixed an observed missed first tap after long press in three repeated cold-start fixture runs; the updated production APK is installed with application-table contents unchanged. Empty-list device rendering, actual finger input, production navigation, and native pixel comparison remain open. See `artifacts/touch-queue-deployment-receipt.json`.

Implemented operations include create/read/edit, pin/unpin, move to an existing folder or unclassified, folder creation at the repository layer, and tombstone delete with confirmation. The native watch actions screen likewise only moves to existing folders; it has no folder-creation button. Subsequent work added inline editing, undo/redo, cursor anchoring, native paragraph layout, table preview, and an image-failure download dialog. These are individually validated in [implementation status](implementation-status.md); Android database import, complete note synchronization/conflict handling, all rich Markdown states, and physical interaction parity remain open.
