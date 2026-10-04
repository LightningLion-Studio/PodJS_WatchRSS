# RFCOMM transport implementation

The native app listens on classic Bluetooth RFCOMM using the service name
`WatchRSS Bluetooth Sync` and UUID `bb2f0b7d-8f2f-4a96-95b2-d2c91d58a861`.
PodJS's existing companion BLE protocol is a different transport and cannot
serve that phone client directly.

The Android host now has guest-scoped RFCOMM listeners and bounded byte-stream
handles. It checks Bluetooth connection permission and adapter state, opens a
secure RFCOMM service, accepts a peer, reads/writes at most 64 KiB per operation,
and closes pending I/O on timeout or cancellation. EOF releases the underlying
stream. Four total handles bound resource use. Stream work runs independently
of the SQLite worker; deadlines close native owners to unblock actual I/O.
Late cancelled listener/accept results are disposed rather than leaked.

Framework APIs are `rfcomm.status/listen/accept/close` and
`byteStreams.read/write/close`. Their capability identifiers are `net.rfcomm`
and `net.stream`. They are defined but not yet advertised in target profiles
or the native boot capability list. Main-entry permission/lifecycle integration
and a guest-to-phone test remain required before enabling them there.

The application `RfcommLibraryListener` uses the native service identity,
creates a `StreamFrameConnection`, and runs `LibrarySyncSession`. Stop cancels
pending accept/read work and closes listener/stream handles, including a stop
issued by the peer-connected callback. `rfcomm-host.ts` binds the pure listener
to actual framework services; the main UI does not invoke it yet.

## Verification

`PodByteStreamServicesTest` ran on e3aca8af in the separate
`dev.podjs.runtime.test` application: six tests passed in 0.54 seconds.
They cover loopback-socket bounded reads/writes and EOF, deadline closure,
cancellation/service-close unblocking, oversized writes, real RFCOMM listener
creation/closure, and a dispatcher-level test proving a blocked stream read
does not block a SQLite query. Bluetooth was available, enabled, and its
connection permission was granted. This proves native listener lifecycle;
it does not prove a remote phone connected or exchanged data over Bluetooth.

Application tests cover the native service identity, a complete fragmented
probe/ACK session, stopping during accept/peer notification, permission errors,
simultaneous starts, write-count checks, and idempotent close. Five new tests
passed. Full application suite: 374 tests / 46401 assertions. Framework suite:
58 tests / 332 assertions. TypeScript and Android test packaging passed.

An initial aggregate application test run exposed a shared mock export conflict.
The pure listener now uses injected ports and a separate host factory; the
subsequent full run passed. The main installed APK remains a9ba3025 from the
previous increment. This increment installed only the runtime test APK, with no
main-app data changes or physical-input simulation.

Remaining: public capability enablement, runtime Bluetooth permission flow,
connection UI/lifecycle and foreground policy, actual paired-phone transfer,
IP WebSocket routing, media/cache cleanup integration and physical acceptance.
