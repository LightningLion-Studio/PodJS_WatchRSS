# Settings migration

The PodJS settings screen follows the Android watch source rows and its measured round-screen geometry: 18px outer padding, 8px row gaps, 64px setting rows, and 34px page headers. `SettingsScreen` owns top-level and advanced navigation while the parent owns route integration through `onNavigate`.

Persisted controls are limited to values with a target consumer: reading font size, media volume controls, playback start limit, cache limit, media cache mode, sync keep-alive, and share mode. `SettingsStore` stores one validated JSON object at `watchrss.settings`; malformed or out-of-range data falls back to source defaults. Cache clearing and log deletion remain visible as explicit unsupported states until a host storage service is wired.
