# Sync encoding performance

The storage fixture exposed long guest CPU tasks while processing large bodies.
An isolated on-watch profile measures existing Base64, a batched JavaScript
candidate, Java-style UTF-8 and JSON quoting. It compares encoded bytes before
accepting each candidate. Each value is the mean of three executions; millisecond
clock resolution limits the precision of the native result.

With the native encoder available, the same process measured 64 KiB Base64 at
409.33 ms for the portable implementation and 1 ms for the native implementation.
The batched JavaScript candidate measured 131.67 ms. The native result matched
the portable result. Java-style UTF-8 encoding of 32768 UTF-16 units measured
86 ms; JSON quoting of 720000 UTF-16 units measured 3210 ms. These are component
measurements, not end-to-end sync latency or throughput.

The framework now chooses the runtime's optional `pod.encodeBase64(Uint8Array)`.
It respects subarray offsets and lengths, uses standard padding, leaves the
input unchanged, and returns an owned string. Older runtimes retain the portable
fallback. The PocketJS vendor tree is unchanged by this increment.

Runtime tests passed (59), framework tests passed (60), and the application
suite passed (390 tests, 46512 assertions); TypeScript passed. A profiling harness
initially used unavailable global `setTimeout`; it was corrected to the framework
host delay. A new runtime test initially omitted its required frame entry; after
fixing the fixture, the encoder and full runtime suite passed.

The unchanged three-body production storage fixture passed in 430220 ms,
compared with 800018 ms in the preceding run (about 46 percent less elapsed time).
Its source hash matches the earlier receipt. The initial body-file cache differs:
the prior run reused existing immutable files, whereas this run began with an
empty body directory. This is an observed fixture improvement, not a controlled
throughput claim. Exported texts, metadata-only receive, immutable publication,
replacement and cleanup all passed. The stopped fixture database and body-file
directory were verified empty afterward.

Multi-second guest tasks remain in the log. This change does not establish
acceptable large-library latency or responsive sync UI. Main radio/IP integration,
power/media lifecycle ports and physical interaction/visual acceptance remain
outstanding. Package hashes, library cohort checks, regression results and main
data-preservation comparison are recorded in `artifacts/encoding-receipt.json`.
