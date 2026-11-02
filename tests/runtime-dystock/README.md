# T-DYSTOCK local runtime fixture

Only the feed transport endpoint changes. The app uses its production Home,
Douyin parser, SQL state, stock, MP4 preparation, Media3 sessions and player UI.
The dedicated entry is `src/dystock-fixture.tsx`; normal `src/main.tsx` does not import it.
The transport seam requires the native debug build gate and retains existing service owners.

Use an isolated app/framework worktree with private dependencies. Use only the owned
`emulator-5560` from the shared `emu-douyin.sh` tool. Never import account cookies.

1. `python3 tests/runtime-dystock/tools/make-media.py "$evidence/media"`
2. Start `python3 tests/runtime-dystock/tools/server.py "$evidence" "$app"` in a persistent process.
   It binds host loopback on a random port. It generates a synthetic pairing Cookie in
   ignored `runtime-config.generated.ts` (mode 0600). Never print or commit that file.
3. `python3 tests/runtime-dystock/tools/configure.py "$app"`
4. Build the complete config using the isolated framework CLI:
   `bun "$framework/packages/cli/src/cli.ts" package android-watch --project="$app/pod.dystock-fixture.config.json"`
   Use the x86_64 / two-worker environment from `emu-build-debug.sh`.
5. Install with `emu-douyin.sh install 5560 "$apk"`. Before any app launch, run
   `python3 tests/runtime-dystock/tools/isolate.py "$evidence"`.
   This uses an exact package-name UID match and rejects IPv4/IPv6 non-loopback egress.
6. Start `python3 tests/runtime-dystock/tools/collect.py "$evidence"` persistently.
   Its first detail/backoff event force-stops this app and writes `ABORT.json`.
7. Start the normal main activity. Complete the normal onboarding and platform disclosures.
   Do not tap the Douyin play arrow during setup. Confirm Home fills 3 stock slots.
8. Run `python3 tests/runtime-dystock/tools/run.py "$evidence" suite`.
   Each cold run verifies airplane mode, disabled Wi-Fi, no active default network,
   a fresh PID, restored stock, native cached first frame, and 26 seconds of player samples.
   Each refill starts a fresh Home process and waits for 3 verified stock slots.
9. Inspect the saved native event / request ledgers, first/progress/end screenshots,
   and player positions. A screenshot or first-frame event alone does not prove playback.
   Count requests before first frame using host collection monotonic time plus the recorded
   host clock offset; device wall time can differ from host wall time.
10. Stop the collector/server and kill only port 5560 with the ownership-checking helper.

Airplane mode does not stop ADB reverse. The server therefore closes every paired request
without sending any data when `phase.json` has `online:false`. Cold runs cannot refill
through the fixture. The request ledger stores only closed metadata and no headers/URLs.
The server accepts only its generated pairing Cookie. Feed IDs and credentials are synthetic.

MP4s are real H.264/AAC, 20 seconds, 320x480, with a constant-bitrate filler stream.
`head` has faststart moov; `tail` has moov after mdat; `large-moov` adds a valid 800 KiB
free child to the tail moov; `ignore200` always returns the entire head file for Range.
206 responses return exactly the requested bytes and Content-Range. Native stock remains
bounded to 4 MiB per item. These are emulator functional checks, not watch performance proof.

The host server can resume after an interrupted host process with `--resume`.
It reuses the existing synthetic pairing key, port, page sequence and request ledger.
A missing or invalid phase file fails closed. The reusable driver publishes phases atomically.
`tools/check-server.py "$evidence/media" "$evidence/server-checks.json"` checks exact
206/200 bytes, feed parsing, wrong pairing, unknown paths and offline/missing-phase denial.
