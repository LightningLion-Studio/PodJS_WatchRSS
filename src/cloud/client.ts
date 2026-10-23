import {cloudDisabled,type CloudGuard} from "./guard";
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
export class CloudRequestError extends Error {
  constructor(readonly status:number,readonly code:string){super(`Cloud HTTP ${status}${code?' '+code:''}`);}
}
function requireOk(response: HttpResponse): any {
  if (response.status < 200 || response.status >= 300) {let code='';try{const e=parse(response);const value=typeof e.error==='string'?e.error:typeof e.error?.code==='string'?e.error.code:e.code;if(typeof value==='string'&&/^[a-z_]{1,80}$/.test(value))code=value;}catch{}throw new CloudRequestError(response.status,code.trim());};
  return parse(response);
}
function member(v: any) { return { plan: v.plan || "free", active: !!v.active, writable: !!v.writable, readable: !!v.readable, quotaBytes: Number(v.quotaBytes || 0), usedBytes: Number(v.usedBytes || 0), reservedBytes: Number(v.reservedBytes || 0), retentionDays: v.retentionDays == null ? null : Number(v.retentionDays), readOnlyAt: v.readOnlyAt == null ? null : String(v.readOnlyAt), deleteAfter: v.deleteAfter == null ? null : String(v.deleteAfter) }; }
function head(v: any): CloudSnapshotHead { return { id: String(v.id), sourceDeviceId: String(v.sourceDeviceId), deviceSequence: Number(v.deviceSequence), keyVersion: Number(v.keyVersion || 1), manifestSha256: String(v.manifestSha256), manifestSizeBytes: Number(v.manifestSizeBytes), parentHeads: { ...(v.parentHeads || {}) }, observedHeads: Object.fromEntries(Object.keys(v.observedHeads || {}).map(k => [k, Number(v.observedHeads[k])] )) }; }

export class WatchCloudClient {
  private epoch?:string;
  setEpoch(epoch:string){this.epoch=epoch;}
  constructor(private readonly http: HttpTransport, private readonly options: CloudClientOptions, private readonly crypto: CloudCrypto, private readonly guard: CloudGuard = cloudDisabled) {}
  private async request(method: string, path: string, body?: unknown,raw?:Uint8Array): Promise<HttpResponse> {
    this.guard.require();
    const token=this.options.refreshToken?await this.options.refreshToken(false):this.options.accessToken;
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}` };
    if(method!=='GET'&&path.startsWith('/functions/v1/cloud/')&&!path.endsWith('/bootstrap')){
      const epoch=this.epoch??this.options.libraryEpoch;if(!epoch)throw Error('client_upgrade_required');headers['x-watchrss-library-epoch']=epoch;
    }
    if (this.options.apikey) headers.apikey = this.options.apikey;
    if (this.options.deviceAccessToken) headers["x-watchrss-device-authorization"] = `Bearer ${this.options.deviceAccessToken}`;
    if (this.options.appVersion) headers["X-WatchRSS-App-Version"] = this.options.appVersion;
    if(raw)headers["content-type"]="application/octet-stream";
    else if (body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
    const request={ method, url: this.options.baseUrl.replace(/\/$/, "") + path, headers, body: raw??(body === undefined ? undefined : jsonBytes(body)) };
    let response=await this.http.request(request);
    if(response.status===401&&this.options.refreshToken){this.guard.require();headers.authorization=`Bearer ${await this.options.refreshToken(true,headers.authorization.slice(7))}`;response=await this.http.request(request);}
    if(response.status===401)await this.options.onUnauthorized?.();
    if(response.status===409){let error='';try{error=parse(response).error;}catch{}if(error==='library_epoch_mismatch'){this.epoch=undefined;await this.options.onEpochMismatch?.();throw Error('library_epoch_mismatch');}}
    if(response.status===426)throw Error('client_upgrade_required');
    return response;
  }
  async bootstrap(): Promise<CloudBootstrap> { const j = requireOk(await this.request("POST", "/functions/v1/cloud/bootstrap", {})); return { libraryEpoch:j.libraryEpoch,keyVersionFloor:j.keyVersionFloor,keyCommitments:j.keyCommitments, member: member(j.member), devices: (j.devices || []).map((v: any): RegisteredCloudDevice => ({ deviceId: String(v.deviceId), platform: String(v.platform), displayName: String(v.displayName || ""), publicKeySpki: String(v.publicKeySpki || ""), keyVersion: Number(v.keyVersion || 1), lastSequence: Number(v.lastSequence || 0), attestation:v.attestation,attestationKeyVersion:v.attestationKeyVersion,revokedAt: v.revokedAt == null ? null : String(v.revokedAt) })), keyEnvelopes: (j.keyEnvelopes || []).map((v: any) => ({ id: String(v.id), recipientType: String(v.recipientType), recipientDeviceId: v.recipientDeviceId == null ? null : String(v.recipientDeviceId), envelope: { algorithm: String(v.algorithm), keyVersion: Number(v.keyVersion), wrappedKeyBase64: String(v.wrappedKeyBase64), nonceBase64: String(v.nonceBase64), ephemeralPublicKeySpki: v.ephemeralPublicKeySpki == null ? null : String(v.ephemeralPublicKeySpki) } })) }; }
  async registerDevice(deviceId: string, displayName: string, publicKeySpki: string, keyVersion: number,attestation?:{keyVersion:number;mac:string}): Promise<void> { requireOk(await this.request("POST", "/functions/v1/cloud/devices/register", { deviceId, platform: "watch", displayName, publicKeySpki, keyVersion,...(attestation?{attestation:attestation.mac,attestationKeyVersion:attestation.keyVersion}:{}), capabilities: { snapshotSchema: 2, cloudRelay: true, rtosProtocolReserved: true } })); }
  async revokeDevice(deviceId:string){requireOk(await this.request('POST',`/functions/v1/cloud/devices/${encodeURIComponent(deviceId)}/revoke`,{}));}
  async approvalCreate(deviceId:string,commitment:string){return requireOk(await this.request('POST','/functions/v1/cloud/approvals/v2',{deviceId,commitment})) as {requestId:string;expiresAt:number};}
  async approvalGet(id:string){return requireOk(await this.request('GET',`/functions/v1/cloud/approvals/v2/${encodeURIComponent(id)}`));}
  async approvalReveal(id:string,requesterNonce:string){requireOk(await this.request('POST',`/functions/v1/cloud/approvals/v2/${encodeURIComponent(id)}/reveal`,{requesterNonce}));}
  async approvalCancel(id:string){requireOk(await this.request('POST',`/functions/v1/cloud/approvals/v2/${encodeURIComponent(id)}/cancel`,{}));}
  async records(after:string,deviceId:string):Promise<import('./records').RecordPage>{return requireOk(await this.request('GET',`/functions/v1/cloud/records?after=${encodeURIComponent(after)}&limit=50&deviceId=${encodeURIComponent(deviceId)}`));}
  async pushRecords(items:import('./records').RecordWrite[]):Promise<{formatVersion:1;items:{recordId:string;revision:string}[]}>{return requireOk(await this.request('POST','/functions/v1/cloud/records',{formatVersion:1,items}));}
  async snapshotHeads(): Promise<CloudSnapshotHead[]> { const j = requireOk(await this.request("GET", "/functions/v1/cloud/snapshots/heads")); return (j.heads || []).map(head); }
  async snapshot(id:string):Promise<{manifestUrl:string;chunks:{sha256:string;sizeBytes:number;signedUrl:string}[]}> {
    const j=requireOk(await this.request("GET",`/functions/v1/cloud/snapshots/${encodeURIComponent(id)}`));
    return {manifestUrl:String(j.snapshot.manifestSignedUrl),chunks:(j.chunks||[]).map((v:any)=>({sha256:String(v.sha256),sizeBytes:Number(v.sizeBytes),signedUrl:String(v.signedUrl)}))};
  }
  async download(url:string,size:number,sha256:string):Promise<Uint8Array>{
    this.guard.require();if(!/^https:\/\//.test(url)||!Number.isSafeInteger(size)||size<0||size>8*1024*1024||!/^[0-9a-f]{64}$/.test(sha256))throw Error("无效云对象");
    // Signed storage URLs must never receive account credentials.
    const r=await this.http.request({method:"GET",url,headers:{}});
    if(r.status<200||r.status>=300)throw Error(`Cloud download HTTP ${r.status}`);
    if(r.body.length!==size||await this.crypto.sha256(r.body)!==sha256)throw Error("云对象校验失败");return r.body;
  }
  async reserveSnapshot(snapshot: EncryptedCloudSnapshot, retentionDays: number | null = null): Promise<CloudSnapshotReservation> { this.guard.require(); const manifestSha256 = await this.crypto.sha256(snapshot.encryptedManifest); const chunks = snapshot.manifest.allChunks.filter((v, i, a) => a.findIndex(x => x.ciphertextSha256 === v.ciphertextSha256) === i).map(v => ({ sha256: v.ciphertextSha256, sizeBytes: v.ciphertextBytes })); const m = snapshot.manifest; const j = requireOk(await this.request("POST", "/functions/v1/cloud/snapshots/reserve", { snapshotId: m.snapshotId, sourceDeviceId: m.sourceDeviceId, deviceSequence: m.deviceSequence, keyVersion: m.keyVersion, manifest: { sha256: manifestSha256, sizeBytes: snapshot.encryptedManifest.length }, parentHeads: m.parentHeads, observedHeads: m.observedHeads, retentionDays, chunks })); return { snapshotId: String(j.snapshotId), reservedBytes: Number(j.reservedBytes), missingObjects: (j.missingObjects || []).map((v: any): CloudUploadObject => ({ transport:v.transport,uploadUrl:v.uploadUrl,uploadMethod:v.uploadMethod,reservationId:v.reservationId,kind: String(v.kind), sha256: String(v.sha256), sizeBytes: Number(v.sizeBytes), objectPath: String(v.objectPath), signedUrl: String(v.signedUrl), token: String(v.token), tusEndpoint: String(v.tusEndpoint), bucketName: String(v.bucketName) })) }; }
  /** Only v2 epoch-proxy targets receive account credentials; arbitrary signed/TUS URLs never do. */
  async uploadObject(target:CloudUploadObject,bytes:Uint8Array):Promise<void>{
    this.guard.require();const prefix=this.options.baseUrl.replace(/\/$/,'')+'/functions/v1/cloud/uploads/',url=target.uploadUrl??target.signedUrl,id=url.startsWith(prefix)?url.slice(prefix.length):'';
    if(target.transport!=='epoch-proxy'||target.uploadMethod!=='PUT'||!id||! /^[A-Za-z0-9_-]{1,128}$/.test(id)||target.reservationId!==id)throw Error('无效纪元上传目标');
    if(bytes.length!==target.sizeBytes||bytes.length>8*1024*1024||await this.crypto.sha256(bytes)!==target.sha256)throw Error('待上传云对象校验失败');
    requireOk(await this.request('PUT','/functions/v1/cloud/uploads/'+id,undefined,bytes));
  }
  async completeSnapshot(snapshotId: string, chunkHashes: string[]): Promise<any> { return requireOk(await this.request("POST", "/functions/v1/cloud/snapshots/complete", { snapshotId, chunkHashes })); }
  async acknowledge(snapshotId: string, deviceId: string, result = "applied"): Promise<void> { requireOk(await this.request("POST", `/functions/v1/cloud/snapshots/${encodeURIComponent(snapshotId)}/ack`, { deviceId, result })); }
  async resolveRssSource(sourceUrl: string, mode: "all" | "recent128" = "recent128"): Promise<RssInventory> { const r = requireOk(await this.request("POST", "/functions/v1/rss/sources/resolve", { url: sourceUrl })); if(typeof r.source?.id!=='string'||!r.source.id.trim())throw Error('cloud_source_invalid');const sourceId = r.source.id; const limit = mode === "all" ? "all" : "128"; const j = requireOk(await this.request("GET", `/functions/v1/rss/sources/${encodeURIComponent(sourceId)}/entries?limit=${limit}`)); const source = j.source || {}; return { sourceId, url: sourceUrl, title: String(source.title || ""), description: String(source.description || ""), siteUrl: source.siteUrl == null ? null : String(source.siteUrl), imageUrl: source.imageUrl == null ? null : String(source.imageUrl), items: (j.entries || []).map((e: any) => { const id = String(e.id); return { dedupKey:e.dedupKey==null?undefined:String(e.dedupKey),identityLink:e.link==null?null:String(e.link),audioUrl:e.audioUrl??null,videoUrl:e.videoUrl??null,publishedAt:e.publishedAt??null,url: e.link == null ? `${sourceUrl}${sourceUrl.includes("?") ? "&" : "?"}watchrss_entry=${id}` : String(e.link), title: String(e.title || ""), excerpt: String(e.excerpt || ""), contentHtml: e.contentHtml == null ? null : String(e.contentHtml), contentText: e.contentText == null ? "" : String(e.contentText), imageUrl: e.imageUrl == null ? null : String(e.imageUrl), guid: e.guid == null ? "" : String(e.guid), contentHash: e.contentHash == null ? null : String(e.contentHash) }; }) }; }
}
