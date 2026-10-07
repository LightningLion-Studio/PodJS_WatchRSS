# U5 upstream migration

Baselines: app `4895139`, framework `9f09ca5`, both own wt-impl worktrees,
branch `impl/upstream-4`. Three deliveries: SwipeActionCard, WatchConfirmDialog,
and pure startupExitFrame. U1 #9/#10 are migrated; #17 is only partially migrated
because StartupGate/overlay orchestration remains in the app.

## Compatibility

Application exports and signatures remain stable. The app supplies swipe actions,
164-unit reveal, labels, icons, delete button classes and line measurement.
The framework retains existing JSX classes, geometry, callback order, busy guards,
180ms animation, 8px gesture slop and half-width opening threshold. Startup math
is copied unchanged, including nonfinite input handling and 300ms/1.08 preset.
No navigation/activity, douyin, secure-store or notes reading implementation changed.

`tests/fixtures/upstream-u5` freezes the three files from app `4895139`; only the
dialog's measured-text relative import is relocated. Tests compare node properties,
styles, accessibility, frames and event order, multiple viewport sizes, empty/long/
Unicode messages, busy transitions, swipe thresholds/cancel/edge handling and
reactive open/enabled/class changes. Startup frames are compared over 4000 sampled
times plus boundaries and nonfinite values. Framework contract tests use alternative
actions/width/labels/assets and the production Date clock without injection.
The drawing/gesture harness is mocked and does not establish physical input parity.

## Device handoff (PENDING)

No ADB, device, installation or APK generation. The designated owner should use
the protected upgrade flow, compare home dimensions against the approved density-2
reference, then check RSS/Bili swipe open/close/cancel, horizontal-vs-vertical
arbitration, edge-menu forwarding, both actions, busy delete dialog handling and
cold-start fade/scale. Do not change real account data to exercise callbacks.
Source and package gates do not prove device visuals or frame timing.

## Host verification

- App `bun run test`: 1229 pass, 0 fail (207 files); `bun run typecheck`: exit 0.
- App direct `bun --conditions=browser test ./tests/upstream-u5.isolated.ts`:
  2 pass, 0 fail, 375 assertions. Frozen oracle provenance checked against git.
- Framework `bun run test`: exit 0, including browser tests, host harnesses and
  Rust (103 pass, 4 ignored). `bun x tsc --noEmit`: exit 0.
- Mandatory main CLI and own wt-impl CLI builds: exit 0; latter scans the new
  framework component sources for unknown style properties. Both produced
  99 pak entries, 69,473,376 bytes and 1,641,111 byte bytecode.
- Framework committed as `229198b`; app file: dependencies and framework lock
  point to its wt-impl checkout. Both git diff whitespace checks passed.
- Initial framework runs exposed a missing Babel resolver path in the new test
  and an incomplete host mock in the existing progress-only test after adding
  gesture exports to watch-ui. Test harnesses fixed; final full run passes.
- Logs are retained in `.codex-tmp/wrss-u5-*.log`; no APK generated/installed.
