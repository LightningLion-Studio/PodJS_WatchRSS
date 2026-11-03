# Host test setup

Use Bun (validated with 1.4.4). No watch/emulator is required for `bun test`.

## Local SDK dependencies

`package.json` declares both frameworks as `file:` dependencies. Their paths must
point at the local PodJS SDK checkout; `framework.lock.json` records the expected
revision. Run `bun install --frozen-lockfile` in each fresh worktree.

The app's `postinstall` (`bun scripts/link-framework.ts`) replaces Bun's copied
framework snapshots with **package-directory symlinks**. This preserves SDK
relative imports and makes new source files and export entries visible immediately.
RSS component tests also mock the PocketJS boundaries resolved from the SDK,
since SDK-local dependencies can still have distinct module identities. Do not link
individual `src` files by hand. To repair an existing install, run
`bun run postinstall`. The script reads the `file:` paths from `package.json`, checks
package names before replacing installed entries, and is safe to run repeatedly.
It does not install or modify dependencies in the SDK source checkout.

The lockfile uses the same absolute SDK paths as `package.json`; relative lock
entries previously depended on the worktree's location. If relocating the SDK,
update the manifest paths/override and regenerate the lockfile together.

## Normal and scale tests

Run `bun test` for the full host suite. The always-on TCP/SQLite recovery test uses
128 articles instead of 5500. It still checks a partial checkpoint, disk reopen,
resumption without re-requesting complete bodies, exact article counts, complete
Unicode bodies, no-op and single-article delta under 5 seconds, reverse edits,
legacy compatibility, and lost final ACK recovery. Deterministic diverse body bytes force real multi-frame coverage, which is asserted.

Run the original 5500-article workload explicitly:

```sh
PODJS_SCALE=1 bun test tests/sync/scale-loopback.test.ts
```

The normal isolated callback has a 60-second budget; the full scale callback retains
its 600-second budget. Parent/child watchdogs bound both modes. Bulk ACK waits are
30 seconds normally and 240 seconds in scale mode. The 5-second no-op/delta checks
and production defaults are unchanged. File-backed clock-relay tests use a local
15-second budget: they fsync three databases through multiple relay, cancellation,
re-save and cloud-projection cycles; loaded executions exceeded the default 5 seconds.
No global test timeout is increased.

## Cross-repository comparisons

These optional comparisons need external reference sources. Paths default to
siblings of this app checkout, independent of the shell working directory:

| Variable | Directory | Comparisons |
| --- | --- | --- |
| `ANDROID_WATCHRSS_ROOT` | `../Android_WatchRSS` | Native BLE protocol UUIDs |
| `PODJS_SYNC_VECTORS_DIR` | `../.codex-tmp/cloud-v2/vectors` | R47/R47.1 roots, phone wire vectors, cloud identity vectors |

```sh
ANDROID_WATCHRSS_ROOT=/path/to/Android_WatchRSS \
PODJS_SYNC_VECTORS_DIR=/path/to/cloud-v2/vectors \
bun test
```

When an external file is absent, the corresponding comparison uses `test.skip`
and prints `[external-fixture SKIP]` with the missing path and the variable to set.
Local parser, TTL, descriptor, BLE behavior and checked-in fixture assertions still
run. A present malformed or mismatching external file fails the comparison.
Release verification should set both variables and check that these comparisons
have no skips. A green host run with skips is not evidence of external parity.
