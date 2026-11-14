# Offline Douyin zoom fixture

This fixture mounts the production `VideoPlayerScreen` with a synthetic queue.
It has no Douyin client or remote media URL. Both decoded neighbours use the
same player scale mode. The queue alternates `zoom-0.mp4` (320×180) and
`zoom-1.mp4` (180×320). Each video contains a 60×60 green square.

Use only a newly owned 466×466 round emulator. Record its launch PID and stop
that PID when finished. Always pass its explicit `emulator-<port>` serial to
ADB and confirm `ro.kernel.qemu=1`. Keep Wi-Fi and mobile data disabled.
The application ID is `dev.podjs.tests.dyzoom`.

Generate the two files with FFmpeg, using `color=c=0x123480:s=320x180:r=30`
and `color=c=0x123480:s=180x320:r=30`. Apply this filter to each:

```
drawbox=x=(iw-60)/2:y=(ih-60)/2:w=60:h=60:color=0x00ff00:t=fill,drawbox=x=8:y=8:w=iw-16:h=ih-16:color=white:t=2
```

Encode 12 seconds with H.264, `-preset ultrafast -pix_fmt yuv420p`. Build the
fixture with the locked framework CLI and `pod.config.json`. Install its debug
APK on the owned emulator. Copy the two files into its own
`files/podjs/files/` directory with `run-as dev.podjs.tests.dyzoom`.

At 0°, tap scale at (139,60) to cycle standard → expanded → shrunk. Tap rotate
at (327,60). Later rotate positions are (406,327), (140,406), and (60,140).
Use 400 ms up/down swipes at x=233 between y=340 and y=120. Collect
`dumpsys gfxinfo dev.podjs.tests.dyzoom reset` before each group and
`dumpsys gfxinfo dev.podjs.tests.dyzoom framestats` after each group. Keep
screenshot capture outside the measured groups.

A 1000 ms swipe permits a middle-frame screenshot while the finger is down.
During the 300 ms rotation, the green square keeps its area and square shape.
Its axis-aligned bounding box changes with the angle; that is not deformation.

The existing application diagnostic file is
`files/podjs/files/app_log.txt`. `DouyinAnimation` emits one JSON summary per
scale switch, swipe or rotation. `clock=guest-frame` measures guest callbacks;
`droppedFrames` estimates missed guest callbacks against the stated frame
budget. These fields do not measure decoder drops or native presentation.
Emulator measurements do not establish physical watch performance.
