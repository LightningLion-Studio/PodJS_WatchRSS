# Douyin player Monkey on Linux

The test bundle mounts `VideoPlayerScreen` and its detail panel in the native
PodJS runtime. The runner uses QuickJS, the retained renderer, native hit
testing, touch frames, rotary events and the system Back event. The fixture
supplies eight local media records, delayed mock playback and a synthetic cold
system font cache. The route is separate from the release entry.

Use the application and framework revisions in `framework.lock.json`. The SDK
worktree may be outside the application tree. Set `APP`, `FRAMEWORK` and
`EVIDENCE` to absolute paths. Keep generated outputs outside commits.

```sh
mkdir -p "$EVIDENCE"
export CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=4
export CARGO_TARGET_DIR="$EVIDENCE/native-target"
export PODJS_POCKETJS_REVISION="$(git -C "$FRAMEWORK/vendor/pocketjs" rev-parse HEAD)"
lock="/tmp/wrss-heavy-$(basename "$APP").lock"

flock "$lock" capmem 16G cargo build --offline --locked \
  --manifest-path "$FRAMEWORK/Cargo.toml" -p podjs-runtime
flock "$lock" capmem 16G bun "$FRAMEWORK/packages/cli/src/cli.ts" build \
  --target=android-watch --project="$APP/tests/runtime-dymonkey"

lib="$CARGO_TARGET_DIR/debug/libpodjs_runtime.so"
package="$FRAMEWORK/dist/projects/dev.podjs.tests.dymonkey/android-watch"
flock "$lock" capmem 16G unshare --user --map-current-user --net \
  python3 -B "$APP/tests/runtime-dymonkey/monkey.py" \
  --lib "$lib" --package "$package" --guards --out "$EVIDENCE/guards.json"
flock "$lock" capmem 16G unshare --user --map-current-user --net \
  python3 -B "$APP/tests/runtime-dymonkey/arrow_test.py" \
  --lib "$lib" --package "$package" > "$EVIDENCE/arrow.json"
flock "$lock" capmem 16G unshare --user --map-current-user --net \
  python3 -B "$APP/tests/runtime-dymonkey/panel_rotation_test.py" \
  --lib "$lib" --package "$package" > "$EVIDENCE/panel-rotation.json"
flock "$lock" capmem 16G unshare --user --map-current-user --net \
  python3 -B "$APP/tests/runtime-dymonkey/rotation_cycle_test.py" \
  --lib "$lib" --package "$package" > "$EVIDENCE/rotation-cycle.json"
flock "$lock" capmem 16G unshare --user --map-current-user --net \
  python3 -B "$APP/tests/runtime-dymonkey/monkey.py" \
  --lib "$lib" --package "$package" --seed 50641 --steps 512 --out "$EVIDENCE/seed-50641.json"
flock "$lock" capmem 16G unshare --user --map-current-user --net \
  python3 -B "$APP/tests/runtime-dymonkey/monkey.py" --detail \
  --lib "$lib" --package "$package" --seed 50641 --steps 96 --out "$EVIDENCE/detail-50641.json"
flock "$lock" capmem 16G unshare --user --map-current-user --net \
  python3 -B "$APP/tests/runtime-dymonkey/detail_perf.py" --check \
  --lib "$lib" --package "$package" > "$EVIDENCE/detail-perf.json"
```

- The runner sends a fixed set of input actions. The fixture checks every
  touch point against forbidden rectangles and both hit-test paths before
  the runner submits the native contact. The separate guard test checks
  each of the seven social and account action names and rectangles.
- The first steps exercise the four quarter turns. The seed chooses the
  subsequent actions and the number of frames between them. Screen and
  background cycles use the host lifecycle bridge.
- Every 16 steps the runner opens the panel, scrolls, dismisses it with
  Back, toggles playback and checks that crown input reaches the volume
  port. The runner checks raster output and process PSS at each step.
- The detail profile shuffles scenarios for opening during rotation and
  loading, long cold descriptions, repeated arrow taps, alternating taps
  and swipes, and pressing Back during a held opening swipe. Each scenario
  checks scrolling, Back and re-entry. The saved sequence identifies the
  detail profile for replay.
- The performance probe opens a 20,000-code-point description, checks that
  its first scroll shows text, and measures 30 subsequent scrolls using the
  runtime's guest and surface timings. It checks contact ownership after
  release and verifies play/pause after Back.
- The parent enforces a five-second progress deadline. A guest frame
  over one second also fails. On failure the JSON contains the seed,
  original steps and a replay sequence. The reducer removes chunks and
  then single actions while preserving the same failure. To replay, pass
  `--replay failure.json` in place of `--seed` and `--steps`, and write
  another output file.
- The host grants a closed capability set and rejects unexpected host
  services. The guard controls are canaries. They have assertion handlers
  and omit account and network implementations.

The resource gate uses 250,000 KiB (256,000,000 bytes) and at most three decoders.
Linux process PSS, the software raster and mock decoder counts apply to
this fixture. Android process state, real decoder occupancy, display power
and physical watch behavior require independent device evidence.
