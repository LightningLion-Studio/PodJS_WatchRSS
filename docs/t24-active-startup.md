# T24 ACTIVE cold-start acceptance

Framework candidate: `b20ba04` on `impl/t24`, based on `531dcfd`.
PocketJS remains `c5986b0fdf7d79d3d9346b4a1f02f7c466877852`.
The implementation and durability/concurrency tradeoffs are documented in
PodJS `docs/takeover-active-validation.md`.

WatchRSS keeps its business schema/version initialization and startup routing.
The Android framework owns ACTIVE admission, receipt-bound deep-validation
history, first-texture scheduling and foreground SQL cancellation. Applying the
framework change requires rebuilding the Android runtime and APK; replacing
only WatchRSS JS cannot change admission behavior. This task makes no formal
package install, signing-key change or release version bump.

The candidate accepts converter schema version 0 and the application's versions
1/2 before guest initialization; required tables and the identity row remain
checked. A future schema version must update the framework's admitted-version
contract before deployment. The framework keeps the READY-to-ACTIVE full checks.
Known deep failures block the next cold admission and retain user data for the
existing recovery flow.

`scripts/device/measure_active_startup.py` measures only the fixed OWW242 serial
`e3aca8af` and the isolated non-debug package
`com.lightningstudio.watchrss.podjs.rehearsal`. The caller must first acquire
`DEVICE_OWNER=wrss-impl` after observing `released`, preflight both actual APKs,
and seed an ACTIVE generation. Example from a T24 worktree:

```sh
python -B scripts/device/measure_active_startup.py \
  --owner-file /home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/device/DEVICE_OWNER \
  --reference /home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/device/shots/s4-k8-home-after-cold.png \
  --out /home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/t24/measure-after
```

The measurement starts its primary clock immediately before force-stop, captures
raw screenshots for six seconds and uses the first full-frame RGB MAE=0 match to
the supplied stable Home reference. It also reports a separate launch-request
clock and per-PID numeric startup/PodTakeover timing lines. Screenshot completion
is a conservative visibility upper bound; repeated screencap perturbs startup.
Five launches per candidate, identical app/native assets and same-UID install-r
are required for the before/after comparison. The goals are ACTIVE admission
under 150 ms and force-stop to complete Home at most 2.5 seconds. The result is
rehearsal evidence; formal same-UID migration, Keystore/account continuity and
formal cold-start acceptance require the lead's separate installation task.

For a P10-style simulation, copy only a consistent real business DB, KV and files
into the isolated UID. Publish the candidate through the coordinator with actual
Room/store validation and a new empty target-UID secure store. Never copy formal
activation receipts, sealed backups or Keystore/secure data. Preserve the seed
counts/hash and public APK/source provenance. Remove the rehearsal/test packages,
RAM staging key, encrypted seed and seed-test APK after validation; return the
formal package to Home and release DEVICE_OWNER under its lock.

Task evidence and the final outcome are recorded in the workspace's
`.codex-tmp/t24/` and `.codex-tmp/wrss-impl-report.md`. Those local device artifacts
are deliberately separate from source commits.
