# DYSWIPE ghost regression

This isolated route mounts the production `VideoPlayerScreen` immediately,
with `round=true` so native video/keyframe clipping uses the production circle.
It uses generated local H.264 files in landscape (320x180), portrait (180x320),
and square (240x240) format. A 48x48 white fiducial detects unequal pixel scale.
It never constructs DouyinClient, imports credentials, or selects network media.
The fixture manifest omits all `net.*` capabilities. Keep emulator networking off.
Media generation requires FFmpeg with libx264. Frame analysis requires Python
with OpenCV (`cv2`) and NumPy.

Use only a newly created AVD with DYSWIPE in its name. Every adb command must name
that emulator's serial. Do not use a real watch, login or social actions.

1. Generate files with `python3 tests/runtime-dyswipe-ghost/make-videos.py <media>`.
2. Build this fixture using the framework CLI pinned by `framework.lock.json`.
   Rebuild Java/JNI and the debug host APK with `-PpodAbis=x86_64`.
3. Install only on that AVD. Copy `ghost-0.mp4` through `ghost-2.mp4` into
   `run-as dev.podjs.dyswipe.ghost`'s `files/podjs/files/` directory.
4. Launch `dev.podjs.dyswipe.ghost/dev.podjs.androidwatch.MainActivity`.
5. Tap a blank area once and wait 500 ms to hide the controls. White control
   icons can merge with fiducials and invalidate the aspect measurement.
   Record repeated upward/downward swipes, partial drags and cancellations.
   `adb shell screenrecord` records compositor output, including native video.
6. Run `python3 tests/runtime-dyswipe-ghost/analyze.py <recording.mp4> <output>`.
   Inspect the generated `frames.json` and sampled PNGs alongside the recording.

The analyzer checks every recorded frame for full fiducials with unequal width
and height, and for repeated colour regions. Screen- and page-clipped fiducials are excluded
from the square assertion. It requires moving fiducials, so a stationary or black
recording fails. These checks complement the native tests that inspect *all*
page children and matrices, including cold and cached targets, three aspect
ratios, three scale modes and four quarter-turn rotations. Screenshots do not
establish physical-watch performance or production transport behavior.

Use the task's `flock ... capmem 16G` wrapper for builds, tests and frame analysis.
Keep generated media, APKs, recordings, PNGs and reports outside commits.
