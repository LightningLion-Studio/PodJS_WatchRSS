import { CloudCrypto, CloudClientOptions, CloudBootstrap, RegisteredCloudDevice, CloudSnapshotHead, CloudSnapshotReservation, EncryptedCloudSnapshot, RssInventory, utf8Encode, utf8Decode } from "./types";
import { HttpTransport, HttpResponse, CloudUploadObject } from "./types";

const jsonBytes = (value: unknown) => utf8Encode(JSON.stringify(value));
const text = (body: Uint8Array) => utf8Decode(body);
const parse = (response: HttpResponse): any => { const s = text(response.body); return s.trim() ? JSON.parse(s) : {}; };

function header(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === wanted) return headers[key];
  return undefined;
}
function requireOk(response: HttpResponse): any {
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}: ${text(response.body)}`);
  return parse(response);
}
function member(v: any) { return { plan: v.plan || "free", active: !!v.active, writable: !!v.writable, readable: !!v.readable, quotaBytes: Number(v.quotaBytes || 0), usedBytes: Number(v.usedBytes || 0), reservedBytes: Number(v.reservedBytes || 0), retentionDays: v.retentionDays == null ? null : Number(v.retentionDays), readOnlyAt: v.readOnlyAt == null ? null : String(v.readOnlyAt), deleteAfter: v.deleteAfter == null ? null : String(v.deleteAfter) }; }
function head(v: any): CloudSnapshotHead { return { id: String(v.id), sourceDeviceId: String(v.sourceDeviceId), deviceSequence: Number(v.deviceSequence), keyVersion: Number(v.keyVersion || 1), manifestSha256: String(v.manifestSha256), manifestSizeBytes: Number(v.manifestSizeBytes), parentHeads: { ...(v.parentHeads || {}) }, observedHeads: Object.fromEntries(Object.keys(v.observedHeads || {}).map(k => [k, Number(v.observedHeads[k])] )) }; }

export class WatchCloudClient {
  constructor(private readonly http: HttpTransport, private readonly options: CloudClientOptions, private readonly crypto: CloudCrypto) {}
  private async request(method: string, path: string, body?: unknown): Promise<HttpResponse> {
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${this.options.accessToken}` };
    if (this.options.apikey) headers.apikey = this.options.apikey;
    if (this.options.deviceAccessToken) headers["x-watchrss-device-authorization"] = `Bearer ${this.options.deviceAccessToken}`;
    if (this.options.appVersion) headers["X-WatchRSS-App-Version"] = this.options.appVersion;
    if (body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
    return this.http.request({ method, url: this.options.baseUrl.replace(/\/$/, "") + path, headers, body: body === undefined ? undefined : jsonBytes(body) });
  }
  async bootstrap(): Promise<CloudBootstrap> { const j = requireOk(await this.request("POST", "/functions/v1/cloud/bootstrap", {})); return { member: member(j.member), devices: (j.devices || []).map((v: any): RegisteredCloudDevice => ({ deviceId: String(v.deviceId), platform: String(v.platform), displayName: String(v.displayName || ""), publicKeySpki: String(v.publicKeySpki || ""), keyVersion: Number(v.keyVersion || 1), lastSequence: Number(v.lastSequence || 0), revokedAt: v.revokedAt == null ? null : String(v.revokedAt) })), keyEnvelopes: (j.keyEnvelopes || []).map((v: any) => ({ id: String(v.id), recipientType: String(v.recipientType), recipientDeviceId: v.recipientDeviceId == null ? null : String(v.recipientDeviceId), envelope: { algorithm: String(v.algorithm), keyVersion: Number(v.keyVersion), wrappedKeyBase64: String(v.wrappedKeyBase64), nonceBase64: String(v.nonceBase64), ephemeralPublicKeySpki: v.ephemeralPublicKeySpki == null ? null : String(v.ephemeralPublicKeySpki) } })) }; }
  async registerDevice(deviceId: string, displayName: string, publicKeySpki: string, keyVersion: number): Promise<void> { requireOk(await this.request("POST", "/functions/v1/cloud/devices/register", { deviceId, platform: "phone", displayName, publicKeySpki, keyVersion, capabilities: { snapshotSchema: 2, cloudRelay: true, settings: false, credentialEnvelopes: false } })); }
  async snapshotHeads(): Promise<CloudSnapshotHead[]> { const j = requireOk(await this.request("GET", "/functions/v1/cloud/snapshots/heads")); return (j.heads || []).map(head); }
  async reserveSnapshot(snapshot: EncryptedCloudSnapshot, retentionDays: number | null = null): Promise<CloudSnapshotReservation> { const manifestSha256 = await this.crypto.sha256(snapshot.encryptedManifest); const chunks = snapshot.manifest.allChunks.filter((v, i, a) => a.findIndex(x => x.ciphertextSha256 === v.ciphertextSha256) === i).map(v => ({ sha256: v.ciphertextSha256, sizeBytes: v.ciphertextBytes })); const m = snapshot.manifest; const j = requireOk(await this.request("POST", "/functions/v1/cloud/snapshots/reserve", { snapshotId: m.snapshotId, sourceDeviceId: m.sourceDeviceId, deviceSequence: m.deviceSequence, keyVersion: m.keyVersion, manifest: { sha256: manifestSha256, sizeBytes: snapshot.encryptedManifest.length }, parentHeads: m.parentHeads, observedHeads: m.observedHeads, retentionDays, chunks })); return { snapshotId: String(j.snapshotId), reservedBytes: Number(j.reservedBytes), missingObjects: (j.missingObjects || []).map((v: any): CloudUploadObject => ({ kind: String(v.kind), sha256: String(v.sha256), sizeBytes: Number(v.sizeBytes), objectPath: String(v.objectPath), signedUrl: String(v.signedUrl), token: String(v.token), tusEndpoint: String(v.tusEndpoint), bucketName: String(v.bucketName) })) }; }
  async completeSnapshot(snapshotId: string, chunkHashes: string[]): Promise<any> { return requireOk(await this.request("POST", "/functions/v1/cloud/snapshots/complete", { snapshotId, chunkHashes })); }
  async acknowledge(snapshotId: string, deviceId: string, result = "applied"): Promise<void> { requireOk(await this.request("POST", `/functions/v1/cloud/snapshots/${encodeURIComponent(snapshotId)}/ack`, { deviceId, result })); }
  async resolveRssSource(sourceUrl: string, mode: "all" | "recent128" = "recent128"): Promise<RssInventory> { const r = requireOk(await this.request("POST", "/functions/v1/rss/sources/resolve", { url: sourceUrl })); const sourceId = String(r.source.id); const limit = mode === "all" ? "all" : "128"; const j = requireOk(await this.request("GET", `/functions/v1/rss/sources/${encodeURIComponent(sourceId)}/entries?limit=${limit}`)); const source = j.source || {}; return { url: sourceUrl, title: String(source.title || ""), description: String(source.description || ""), siteUrl: source.siteUrl == null ? null : String(source.siteUrl), imageUrl: source.imageUrl == null ? null : String(source.imageUrl), items: (j.entries || []).map((e: any) => { const id = String(e.id); return { url: e.link == null ? `${sourceUrl}${sourceUrl.includes("?") ? "&" : "?"}watchrss_entry=${id}` : String(e.link), title: String(e.title || ""), excerpt: String(e.excerpt || ""), contentHtml: e.contentHtml == null ? null : String(e.contentHtml), contentText: e.contentText == null ? "" : String(e.contentText), imageUrl: e.imageUrl == null ? null : String(e.imageUrl), guid: e.guid == null ? id : String(e.guid), contentHash: e.contentHash == null ? null : String(e.contentHash) }; }) }; }
}
