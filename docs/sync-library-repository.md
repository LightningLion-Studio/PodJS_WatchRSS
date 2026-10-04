# Source and article deletion repository parity

The source store merges native source records into real channel rows, preserving
local creation/fetch timestamps and original-content/background preferences on
update. Remote source deletions retain an exportable tombstone even when the
channel is absent or the remote source clock is older. Source normalization uses
the repository's HTTP default and Android URI host semantics; article identity
continues using Java URI semantics. The generic host URI service now accepts an
explicit `android` syntax option, with the existing default unchanged.

The article deletion store validates the complete or reusable local body before
mutation, compares the independent native article deletion clock, and commits
article removal and saved-state tombstones in one transaction. Its return count
matches native applied-state semantics. A revision guard aborts deletion when
another library write occurs during body resolution. Local source deletion
statements use the same guard and preserve the exact stored URL, including
Kotlin-trim whitespace at the edges.

## Evidence

- `tests/reference/LibraryRepositoryReferenceTest.kt` runs actual production
  `DefaultRssRepository` operations against isolated in-memory Room databases in
  the reference Android application. The instrumented test passed on e3aca8af
  in 4.579 seconds. Only the reference test APK was installed in this step.
- `tests/fixtures/library-repository-android.json` captures 16 source cases and
  13 article deletion cases, including applied counts, persisted rows, exported
  sources, and post-deletion manifests. The collector checks fixture inputs and
  records hashes of the native implementation.
- `tests/sync/library-repository.test.ts` compares SQLite outcomes with all 29
  captures. It additionally tests failed source writes, atomic source removal,
  and concurrent mutation rejection: 32 tests / 158 assertions passed.
- Application suite: 355 tests / 46257 assertions passed; TypeScript passed.
- Framework suite from the SDK root: 57 tests / 325 assertions passed.
  An initial invocation from the nested package lacked the root JSX settings;
  its text test failed module resolution. The root invocation passed.
- Android `:runtime:compileDebugJavaWithJavac` passed for the new URI branch.

The desktop URI/body ports in these tests use captured Android bytes and known
Java URI behavior; this is not a PodJS device execution of the new repository.
Existing session-device results predate these changes and do not prove them.

## Remaining integration

Source and deletion stores are not yet wired into the main session repository.
The main installed APK remains the earlier version. Still required: local source
removal hook, local deletion journal migration, consistent snapshot/change-log
reconciliation, authoritative snapshot cleanup, actual phone transports and UI,
media side effects, and PodJS device replay of these new source/deletion cases.
`sync_snapshot_fingerprints` is reserved for the pending reconciliation and is
not populated. Revision triggers cover library content tables but deliberately
exclude body-cache metadata, cursor/log tables, and fingerprints.
