# T-NOTES-ADVERSARIAL

Only tests are changed. Failures assert intended behavior and carry report IDs.
Run each process separately; the preview probe mocks native host ports and must
not share a process with other UI tests. Never run heavy commands concurrently.
Dependencies must already be installed locally; no network is needed.

From this worktree:

```sh
NOTES_SOURCE_ROOT=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS NOTES_TITLE_MODULE=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/src/notes/title.ts flock /tmp/wrss-heavy-PodJS_WatchRSS.lock capmem 16G bun test tests/notes-adversarial.test.ts
flock /tmp/wrss-heavy-PodJS_WatchRSS.lock capmem 16G bun test ./tests/notes-adversarial-preview.isolated.ts
```

The first test uses real Bun SQLite with the actual repository and Bluetooth
handler. The preview test uses the actual production generator and semantic row
anchors; it does not rasterize native fonts. Remove `NOTES_SOURCE_ROOT` to test
this branch's baseline. NA-15 skips without `NOTES_TITLE_MODULE`.

After running the phone host compiler and generating the corpus, run the separate
passing controls:

```sh
NOTES_SOURCE_ROOT=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS NOTES_MINI_ROOT=/home/wilf/data/OPPO_Develop/WatchRSS_WeChat NOTES_CORPUS=/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/evidence/T-NOTES-ADVERSARIAL/corpus NOTES_PHONE_JAR=/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/evidence/T-NOTES-ADVERSARIAL/phone-pc2-final/host.jar NOTES_PHONE_CLASSPATH=/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/evidence/T-NOTES-FORMAT-RCA/classpath.txt flock /tmp/wrss-heavy-PodJS_WatchRSS.lock capmem 16G bun test tests/notes-adversarial-wire.test.ts
```

The cloud hop is an opaque local byte buffer. This is not Bluetooth, encrypted
cloud publication, restore receipts, native editor or pixel acceptance. It checks
six codec cycles for all text corpus files and actual v2 scalar segmentation.
The six-cycle test skips if its environment paths are absent; segment tests remain active.

T-NOTES-MERGE-FIX selects this card's merge/repository assertions by default.
Set NOTES_ADVERSARIAL_ALL=1 for the separate NA-12 preview probe; NA-15 still
requires NOTES_TITLE_MODULE. New tests in notes-merge-fix.test.ts cover v2 ID
aliases and cross-client merge/ID equality. Set NOTES_MINI_ROOT to the mini checkout
and NOTES_PHONE_MATRIX to phone-host/merge-matrix.json to run all three clients.
The fixture expectations now reject touching insertions, preserve deletion/edit
conflicts and use the NA-16 ID algorithm. BLE no longer uses the old overwrite rule.
Title tests with changed remote metadata follow the same metadata order as folders;
empty-title derivation remains covered when the selected metadata title is empty.
Use explicit ./tests/... paths with Bun: bare filter strings can also select
unrelated sync-v2 memory benchmarks.

# Notes rendering regressions

Selected from adversarial test commit 6639cddd: NA-12, NA-15, NA-17. Other findings belong to separate tasks.
Run notes-adversarial.test with the existing notes unit tests.
Run notes-adversarial-preview.isolated.ts in a separate Bun process; its native module mocks must not enter other suites.

Derived titles use the first three words and then at most **80 Unicode code
points**, identically in Kotlin, PodJS and the mini app. Explicit nonblank titles
keep their existing behavior. This is a code-point limit, not grapheme segmentation;
no dependency on Intl.Segmenter's grapheme support is introduced.

The shared `notes-title-vectors.json` has 23 cases (18 existing + 5 Unicode limit
cases); the phone copy is `app/src/test/resources/notes-title-vectors.json`.
Native, missing Intl/Segmenter and throwing Segmenter paths use the same limit.

```sh
flock /tmp/wrss-heavy.lock flock /tmp/wrss-heavy-PodJS_WatchRSS.lock capmem 8G bun test tests/notes-adversarial.test.ts tests/notes/title.test.ts tests/note-preview.test.ts
flock /tmp/wrss-heavy.lock flock /tmp/wrss-heavy-PodJS_WatchRSS.lock capmem 8G bun test ./tests/notes-adversarial-preview.isolated.ts
```
