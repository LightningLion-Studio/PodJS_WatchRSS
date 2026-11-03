# DYFIT local geometry fixture

This mounts the production `VideoPlayerScreen` and framework `VideoSessionPool`.
It uses two static H.264 fixtures: cyan portrait 160x240 and orange landscape
240x160, with white grids and yellow borders. Sources alternate by index. It
starts at index 4. All media URLs are loopback on port 18760. It never calls
Douyin or loads cookies. The runtime preserves the foreground player's existing
`standard`, `expanded`, and `shrunk` semantics.

Use isolated app/framework worktrees. Copy private dependencies and bind both
framework packages to the isolated framework. Build x86_64 with the shared
`emu-build-debug.sh` workflow or the normal CLI package pipeline, selecting this
fixture as the project. Its `assets` link supplies production player icons.

Generate both videos with FFmpeg. Example portrait command (swap dimensions
and change cyan to orange for landscape):

```sh
ffmpeg -f lavfi -i 'color=c=0x28b8e8:s=160x240:r=12:d=60' \
  -vf 'drawgrid=w=40:h=40:t=2:c=white,drawbox=x=4:y=4:w=152:h=232:c=yellow:t=4' \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 12 -movflags +faststart portrait.mp4
python3 -m http.server 18760 --bind 127.0.0.1 --directory MEDIA_DIRECTORY
```

Boot an unoccupied, owned harness port. T-DYFIT used emulator-5560. Reverse
`tcp:18760`, install the x86_64 debug APK, dismiss the emulator charging overlay,
and launch `dev.podjs.androidwatch.MainActivity`. Tap `DYFIT LOCAL`. Wait for
both live neighbours. Tap the scale button at physical (139,60), allowing a
render between taps. Confirm the icon and foreground geometry before each mode.
Tap the center to hide controls before screenshots.

For each mode, swipe next and previous. Keep the pointer down midway for 500ms,
capture, release, wait for settle, and capture again. `evidence/T-DYFIT/capture.py`
records physical coordinates and screenshots. Static frames permit an objective
comparison of grid spacing after subtracting the page translation. Changing the
mode must preserve prepared neighbours and cached pixels.

The native test covers cached images, paused TextureViews, cold black pages,
and late frames. Its matrix and draw-invalidation assertions are separate from
these real emulator screenshots. Emulator results are functional checks, not
watch timing or physical display acceptance. Stop only the owned emulator and
HTTP server at cleanup; restore its battery simulation first.
