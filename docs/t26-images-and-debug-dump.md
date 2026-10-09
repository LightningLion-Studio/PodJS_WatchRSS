# T26 image policy and debug provider handoff

Small article cards, avatars and other thumbnail downloads keep the existing
8 MiB ceiling. Reader image blocks, their prefetch and image preview share the
existing `.inline.img` cache variant with a default 64 MiB ceiling. The preview
adapter explicitly selects that variant, so a card's failed 8 MiB download does
not prevent a later full preview and a reader original can be reused by preview.
No NASA-specific URL, host, query parameter or resize rule is introduced.

`imageCachePorts({thumbnailBytes, largeImageBytes})` configures these limits;
positive safe integers up to the Android transport's 64 MiB hard ceiling are
accepted. Existing cache size, ownership and eviction policy remain in effect.
Completed large files count against the inline image budget (128 MiB within
the total configured cache limit), and active leases protect visible images.
The host downloads directly to disk with a 32 KiB buffer. App/JS only reads
bounded overview/tile RGBA output; leaving a preview cancels pending download
and decoder work through the framework's lease/cleanup lifecycle.

PodJS owns the asynchronous debug provider reply and source-dimension checks.
The provider keeps DUMP permission and returns immediately after fd duplication;
its worker waits at most 1.5 seconds, writes one result and closes the duplicate.
The application dump/--clear handlers and receiver/activity actions are unchanged.
A runtime/APK rebuild is required for these fixes; replacing only JS cannot fix
provider deadlock or the Android image source guard.

The task uses an isolated rehearsal package. Actual manifest/signature/ABI and
no native WorkManager takeover must be checked before installation. Four public
NASA original URLs are acceptance fixtures, never product policy. Device
measurements and cleanup evidence belong in `.codex-tmp/t26/`; the task report
records sampled meminfo peaks separately from a continuous allocation peak.
The formal package is not installed, upgraded, cleared or uninstalled here.
