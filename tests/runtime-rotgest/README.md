# Rotated player gesture fixture

This test app mounts the production `VideoPlayerScreen` and the shared
`playerGesture` adapter. Its small shell dispatches signed picture-x drags to
Back or the production detail panel. It shows NEXT/PREVIOUS, the source index,
and the rendered angle on screen. Back displays HOME. It does not mount the
full application router; router arbitration is covered by the gesture tests.

Build with the framework revision in `framework.lock.json`. Use app ID
`dev.podjs.tests.rotgest` on an owned 466×466 round emulator. Place two local
H.264 videos named `rotgest-0.mp4` and `rotgest-1.mp4` in the app's
`files/podjs/files/` directory through `adb -s emulator-<owned-port> shell run-as`.
The fixture has no remote media URLs or service API clients. The `assets`
symlink supplies the production player icons.

Tap Rotate at screen (326,60). Subsequent Rotate locations are (406,326) at
90°, (140,406) at 180°, and (60,140) at 270°. Wait for each 300 ms tween.

| Angle | Picture up (NEXT) | Picture right (Back) | Picture left (detail) |
| --- | --- | --- | --- |
| 90° | (130,233) → (360,233) | (233,130) → (233,360) | (233,360) → (233,130) |
| 270° | (360,233) → (130,233) | (233,360) → (233,130) | (233,130) → (233,360) |

Use `adb -s emulator-<owned-port> shell input swipe x1 y1 x2 y2 350`.
A source change resets rotation to 0°, matching existing player behavior.
The detail panel stays upright; its own page/dismiss gestures use screen axes.
