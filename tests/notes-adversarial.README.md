# T-NOTES-ADVERSARIAL

Only tests are changed. Failures assert intended behavior and carry report IDs.
Run each process separately; the preview probe mocks native host ports and must
not share a process with other UI tests. Never run heavy commands concurrently.
Dependencies must already be installed locally; no network is needed.

From this worktree:

```sh
NOTES_SOURCE_ROOT=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-notes-title-3w NOTES_TITLE_MODULE=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-notes-title-3w/src/notes/title.ts flock /tmp/wrss-heavy-PodJS_WatchRSS.wt-notes-adversarial.lock capmem 16G bun test tests/notes-adversarial.test.ts
flock /tmp/wrss-heavy-PodJS_WatchRSS.wt-notes-adversarial.lock capmem 16G bun test ./tests/notes-adversarial-preview.isolated.ts
```

The first test uses real Bun SQLite with the actual repository and Bluetooth
handler. The preview test uses the actual production generator and semantic row
anchors; it does not rasterize native fonts. Remove `NOTES_SOURCE_ROOT` to test
this branch's baseline. NA-15 skips without `NOTES_TITLE_MODULE`.

After running the phone host compiler and generating the corpus, run the separate
passing controls:

```sh
NOTES_SOURCE_ROOT=/home/wilf/data/OPPO_Develop/PodJS_WatchRSS.wt-notes-title-3w NOTES_MINI_ROOT=/home/wilf/data/OPPO_Develop/WatchRSS_WeChat.wt-notes-title-3w NOTES_CORPUS=/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/evidence/T-NOTES-ADVERSARIAL/corpus NOTES_PHONE_JAR=/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/evidence/T-NOTES-ADVERSARIAL/phone-pc2-final/host.jar NOTES_PHONE_CLASSPATH=/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/evidence/T-NOTES-FORMAT-RCA/classpath.txt flock /tmp/wrss-heavy-PodJS_WatchRSS.wt-notes-adversarial.lock capmem 16G bun test tests/notes-adversarial-wire.test.ts
```

The cloud hop is an opaque local byte buffer. This is not Bluetooth, encrypted
cloud publication, restore receipts, native editor or pixel acceptance. It checks
six codec cycles for all text corpus files and actual v2 scalar segmentation.
The six-cycle test skips if its environment paths are absent; segment tests remain active.
