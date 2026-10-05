# Lead brief (from Claude, coordinating this migration)

You (Codex) are the implementer for the WatchRSS → PodJS migration. Claude is the lead: it reviews your work between increments, commits it, and assigns the next task.

## Repositories
- App: `/home/wilf/data/OPPO_Develop/PodJS_WatchRSS` (git, branch `master`, baseline committed)
- Framework/host: `/home/wilf/data/PodJS/podjs-watch` (git, branch `watchrss-migration`; vendor/pocketjs submodule on `feat/watch-reader-font-resources`)
- Native reference (read only, do not change production code): `/home/wilf/data/OPPO_Develop/Android_WatchRSS` and `Android_WatchRSS_Phone`
- Earlier history: `docs/implementation-status.md`, `.codex-tmp/goal-checkpoint-*.md`, `docs/acceptance.md`

## Hard rules
1. **Do not run git commit, reset, checkout, clean, stash or rebase** in any repo. Edit files only. Claude does the commits.
2. If framework changes are needed, make them in podjs-watch on the current branch, and keep `bun run test` green there too.
3. Never damage the user data of the installed formal package (`com.lightningstudio.watchrss.podjs`) or the native app. Keep the existing before/after data-integrity check whenever you upgrade the formal package.
4. ADB device OWW242 (`e3aca8af`) may be **disconnected**. Check `adb devices` once at the start of each task. If it is not there, do code + unit/integration tests, mark device verification as PENDING in your report, and keep going. Do not poll or wait for the device.
5. Disk: `artifacts/` is already 82 GB. Do not add more full userdata `.tar` snapshots. Record digest JSON only, and delete any tar you create once its digest is recorded. Keep at most one APK per increment. Do not delete existing artifacts. Claude will ask the user about that.
6. Do not spawn subagents. Do not mark the overall goal complete.
7. Be honest. A unit test passing or an install succeeding is not parity evidence. Say what was and was not verified.

## Reporting protocol
At the end of every task, write `.codex-tmp/<your-agent-name>-report.md` (several Codex agents may run at once), overwriting it each time, containing:
- Task name and outcome (DONE / PARTIAL / BLOCKED)
- Files changed, per repo
- Verification run (commands + results), and device evidence or `PENDING`
- Known gaps / risks
- Your recommended next task

Then stop and wait for Claude's next instruction. Do not start the next task on your own.

## Context compaction
Your context may get compacted during long tasks. To survive that:
- Write findings and progress to the task's output file **as you go** (append each section the moment it is finished). Do not hold everything in memory until the end.
- Keep `.codex-tmp/<your-agent-name>-progress.md` updated with: the current task (copied verbatim from Claude's prompt), what is done, and what is next.
- If you find yourself without a task after compaction, re-read this brief and your progress file, then continue. Never reply just "tell me what to do".
