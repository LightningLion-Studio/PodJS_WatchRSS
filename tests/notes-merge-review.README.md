# T-REVIEW-NOTES-MERGE-FIX

Test-only review of 79129f1b. `notes-merge-review.test.ts` deliberately fails on RVM-04 (resurrection), RVM-05 (a resolved alias lost during actual SQLite materialization), and RVM-08 (ancestor replay after reverting text). The single-ID marker control passes.

```sh
flock /tmp/wrss-heavy-PodJS_WatchRSS.wt-notes-merge-review.lock capmem 8G bun test --timeout 30000 ./tests/notes-merge-review.test.ts
```

Use already-installed dependencies; no install or network access is needed. `notes-merge-review-wire.test.ts` accepts `NOTES_MINI_ROOT`, `NOTES_COMPOSE_DIR`, `NOTES_PHONE_JAR`, and `NOTES_PHONE_CLASSPATH`. It verifies unchanged mini v1 codec bytes against the parent commit and passes actual frozen Compose records through watch, mini, and phone codecs. The phone review runner creates the Compose fixtures. All fixtures are synthetic. No server or device is used.
