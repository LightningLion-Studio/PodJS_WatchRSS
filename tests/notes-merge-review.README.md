# T-REVIEW-NOTES-MERGE-FIX

Test-only review of 79129f1b. `notes-merge-review.test.ts` deliberately fails on RVM-04 (resurrection), RVM-05 (a resolved alias lost during actual SQLite materialization), and RVM-08 (ancestor replay after reverting text). The single-ID marker control passes.

```sh
flock /tmp/wrss-heavy-PodJS_WatchRSS.lock capmem 8G bun test --timeout 30000 ./tests/notes-merge-review.test.ts
```

Use already-installed dependencies; no install or network access is needed. `notes-merge-review-wire.test.ts` accepts `NOTES_MINI_ROOT`, `NOTES_COMPOSE_DIR`, `NOTES_PHONE_JAR`, and `NOTES_PHONE_CLASSPATH`. It verifies unchanged mini v1 codec bytes against the parent commit and passes actual frozen Compose records through watch, mini, and phone codecs. The phone review runner creates the Compose fixtures. All fixtures are synthetic. No server or device is used.

T-NOTES-MERGE-FIX r2 keeps the review assertions and adds tests for cyclic ancestry
in both arrival orders, raw incoming aliases, and the actual SQL business apply.
A foreign metadata edit cannot restore an unchanged deleted body. A two-way ancestry cycle preserves both
bodies as a conflict and selects the current row by the existing metadata order;
the order does not constitute proof of causality. Resolution markers join their
original IDs before alias collapse during export. Incoming conflict sets are
normalized before business writes and before open-conflict gates.

A newer version from the same nonempty deleting device can explicitly restore
the same body. Foreign metadata cannot. The existing same-writer BLE ordering
and encrypted mini restore fixtures retain their original assertions.
