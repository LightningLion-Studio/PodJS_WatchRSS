# Debug credential backup

The external debug receiver supports `EXPORT_CREDENTIALS` and `IMPORT_CREDENTIALS` under `com.lightningstudio.watchrss.debug.action.`. Both use the existing host `DebugGate`; ordinary release packages reject them. The script also checks `run-as` before starting an Activity or sending an action.

```sh
python3 scripts/device/credentials.py export --package dev.podjs.credentials.rehearsal
python3 scripts/device/credentials.py import --package dev.podjs.credentials.rehearsal
```

The package defaults to `com.lightningstudio.watchrss`. That default requires a separately authorized debug build of the formal package; T21 tests use only the rehearsal package. ADB always uses serial `e3aca8af`.

Backups go to `~/.local/share/watchrss/credentials-<package>.json`. The directory has mode 0700 and files have mode 0600. The script atomically replaces the host backup, refuses symlink imports, captures ADB output, and prints only key names, counts and the first eight hexadecimal digits of each stored value's SHA256. It creates no device files.

The version 1 snapshot is an object with exactly `version` and `values`. The `values` object has exactly three keys, each holding its original secure-store string or `null`:

| Secure key | Content |
| --- | --- |
| `watchrss.bili.session.v1` | Bili cookies, refresh token and session timestamps |
| `douyin.cookie` | Douyin cookie string |
| `state_json` | Bound WatchRSS account access/refresh tokens and account metadata |

WBI signing keys, TTS service API keys, playback history, pairing/Keystore keys, and migration receipts are excluded. Missing credentials are represented by `null`; importing `null` clears that login. Import replaces all three allowlisted entries and retains unrelated secure-store entries.

Snapshots are limited to 12000 UTF8 bytes. `IMPORT_CREDENTIALS` receives the JSON as the `snapshot_base64` intent extra. It validates version, allowlist and nested structures before one encrypted `secure.update` transaction. Bili drops its memoized session and WBI state; Douyin performs the same cookie/feed invalidation as `applyCookie`/`clearCookie`; account observers are notified. Only export replies contain credentials. Import replies contain `ok` or a generic failure code.

Keep the target app idle during restore. The secure-store publication is atomic; subsequent cache cleanup and observer notification are separate operations. If cache cleanup fails, the action reports failure even though the credentials may already be committed; restarting the debug app refreshes the clients.
