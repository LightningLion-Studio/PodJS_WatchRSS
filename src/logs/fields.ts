/** Only public numeric platform IDs may be interpolated; arbitrary identifiers can
 * contain imported user text, cookies or URLs. The final sink still applies redact. */
export function logPlatformId(value:unknown):string {
 return typeof value==='string'&&/^[0-9]{1,24}$/.test(value)?value:'<redacted>';
}
/** Enum values cross host/network boundaries; TypeScript types are not validation. */
export function logIpRoute(value:unknown):string {
 return value==='wifiLan'||value==='phoneHotspot'||value==='bluetoothBridge'||value==='unknownLocal'?value:'<redacted>';
}
