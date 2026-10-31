import {snapshotDeferred} from './snapshot-deferral';
import {cloudFormatFailure,emitCloudFormat,type CloudFormatHttpMetric} from './format-diagnostic';
import {cloudFormatCapabilities} from './compatibility';
import {parseContentState,contentGenerationValid,contentWrite} from './content-lifecycle';
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
  if (response.status < 200 || response.status >= 300) {let code='';try{const e=parse(response);const value=typeof e.error==='string'?e.error:typeof e.error?.code==='string'?e.error.code:e.code;if(typeof value==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(value))code=value;}catch{}throw new CloudRequestError(response.status,code.trim());};
  return parse(response);
}
function member(v: any) { return { plan: v.plan || "free", active: !!v.active, writable: !!v.writable, readable: !!v.readable, quotaBytes: Number(v.quotaBytes || 0), usedBytes: Number(v.usedBytes || 0), reservedBytes: Number(v.reservedBytes || 0), retentionDays: v.retentionDays == null ? null : Number(v.retentionDays), readOnlyAt: v.readOnlyAt == null ? null : String(v.readOnlyAt), deleteAfter: v.deleteAfter == null ? null : String(v.deleteAfter) }; }
function head(v: any): CloudSnapshotHead { return { ...(v.contentLayout===3||v.contentLayout===null?{contentLayout:v.contentLayout}:{}),...(Number.isSafeInteger(v.totalSizeBytes)&&v.totalSizeBytes>=0?{totalSizeBytes:v.totalSizeBytes}:{}),id: String(v.id), sourceDeviceId: String(v.sourceDeviceId), deviceSequence: Number(v.deviceSequence), keyVersion: Number(v.keyVersion || 1), manifestSha256: String(v.manifestSha256), manifestSizeBytes: Number(v.manifestSizeBytes), parentHeads: { ...(v.parentHeads || {}) }, observedHeads: Object.fromEntries(Object.keys(v.observedHeads || {}).map(k => [k, Number(v.observedHeads[k])] )) }; }

export class WatchCloudClient {
  private epoch?:string;private generation?:string;
  private requiredFormatFeatures:string[]=[];private featureScope?:string;
  get requiredFeatures(){return [...this.requiredFormatFeatures];}
  private observeRequiredFeatures(raw:any){
    if(raw.requiredFeatures===undefined)return;
    const features=raw.requiredFeatures;if(!Array.isArray(features)||features.length>16||features.some(f=>typeof f!=='string'||!/^[a-z0-9][a-z0-9.-]{0,47}$/.test(f))||new Set(features).size!==features.length)throw new CloudRequestError(426,'cloud_format_upgrade_required');
    const scope=typeof raw.libraryEpoch==='string'&&contentGenerationValid(raw.contentGeneration)?raw.libraryEpoch+':'+raw.contentGeneration.toLowerCase():undefined;
    if(scope&&this.featureScope&&scope!==this.featureScope)this.requiredFormatFeatures=[];
    if(scope)this.featureScope=scope;this.requiredFormatFeatures=[...new Set([...this.requiredFormatFeatures,...features])].sort();
  }
  private r48WriteUntil=0;private r48WriteFrom=0;private r48GateRequest=0;private r48Snapshots=new Set<string>();
  get r48WriteEnabled(){return this.options.r48WriteV1===true&&(this.options.now??Date.now)()>=this.r48WriteFrom&&(this.options.now??Date.now)()<this.r48WriteUntil;}
  /** No persisted authorization. Failure, missing/old response or stale cache
   * closes writes; reading already accepted data never consults this gate. */
  async refreshR48WriteGate():Promise<boolean>{
    const revision=++this.r48GateRequest;this.r48WriteUntil=0;if(this.options.r48WriteV1!==true)return false;
    const started=(this.options.now??Date.now)();
    const value=await this.formatCapabilities();
    if(revision===this.r48GateRequest&&value.protocol==='watchrss-content-evolution'&&value.version===1&&value.phaseA?.cloudFormatR48WriteV1===true&&value.phaseA?.cloudFormatR48ReadV1===true){this.r48WriteFrom=started;this.r48WriteUntil=started+30000;}
    return this.r48WriteEnabled;
  }
  setContentGeneration(generation:string){if(!contentGenerationValid(generation))throw new CloudRequestError(426,'client_upgrade_required');this.generation=generation.toLowerCase();}
  private contentResponse(value:unknown){const state=parseContentState(value);if(this.generation&&state.contentGeneration!==this.generation)throw new CloudRequestError(409,'cloud_content_rebuild_required');this.observeRequiredFeatures(value);return state;}
  setEpoch(epoch:string){this.epoch=epoch;}
  constructor(private readonly http: HttpTransport, private readonly options: CloudClientOptions, private readonly crypto: CloudCrypto, private readonly guard: CloudGuard = cloudDisabled) {}
  private async request(method: string, path: string, body?: unknown,raw?:Uint8Array,r48Write=false): Promise<HttpResponse> {
    this.guard.require();
    // This build reads provenance but cannot publish it. Consumption ACKs,
    // GET/bootstrap and cancellation remain available; never invent a header.
    if(this.requiredFormatFeatures.length&&((method==='POST'&&['/functions/v1/cloud/records','/functions/v1/cloud/snapshots/reserve','/functions/v1/cloud/snapshots/complete'].includes(path))||(method==='PUT'&&path.startsWith('/functions/v1/cloud/uploads/'))))throw new CloudRequestError(426,'cloud_format_upgrade_required');
    const token=this.options.refreshToken?await this.options.refreshToken(false):this.options.accessToken;
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}` };
    if(method!=='GET'&&path.startsWith('/functions/v1/cloud/')&&!path.endsWith('/bootstrap')){
      const epoch=this.epoch??this.options.libraryEpoch;if(!epoch)throw Error('client_upgrade_required');headers['x-watchrss-library-epoch']=epoch;
    }
    if(contentWrite(method,path)){if(!this.generation)throw new CloudRequestError(426,'client_upgrade_required');headers['x-watchrss-content-generation']=this.generation;}
    if(r48Write)headers['x-watchrss-r48-write-v1']='1';
    if (this.options.apikey) headers.apikey = this.options.apikey;
    if (this.options.deviceAccessToken) headers["x-watchrss-device-authorization"] = `Bearer ${this.options.deviceAccessToken}`;
    if (this.options.appVersion) headers["X-WatchRSS-App-Version"] = this.options.appVersion;
    if(raw)headers["content-type"]="application/octet-stream";
    else if (body !== undefined) headers["content-type"] = "application/json; charset=utf-8";
    const request={ method, url: this.options.baseUrl.replace(/\/$/, "") + path, headers, body: raw??(body === undefined ? undefined : jsonBytes(body)) };
    const operation:CloudFormatHttpMetric['operation']|undefined=path.endsWith('/format-capabilities')?'capabilities':path.endsWith('/snapshots/reserve')?'reserve':path.endsWith('/snapshots/complete')?'complete':method==='PUT'&&path.startsWith('/functions/v1/cloud/uploads/')?'upload':undefined;
    const send=async()=>{
      const started=(this.options.now??Date.now)();
      try{const response=await this.http.request(request);if(operation)emitCloudFormat(this.options.formatDiagnostic,{event:'format-http',operation,status:response.status,success:response.status>=200&&response.status<300,category:response.status>=200&&response.status<300?'none':cloudFormatFailure(undefined,response.status),durationMillis:Math.max(0,(this.options.now??Date.now)()-started),submittedBytes:request.body?.length??0,responseBytes:response.body.length});return response;}
      catch(error){if(operation)emitCloudFormat(this.options.formatDiagnostic,{event:'format-http',operation,status:0,success:false,category:'transport',durationMillis:Math.max(0,(this.options.now??Date.now)()-started),submittedBytes:request.body?.length??0,responseBytes:0});throw error;}
    };
    let response=await send();
    if(response.status===401&&this.options.refreshToken){this.guard.require();headers.authorization=`Bearer ${await this.options.refreshToken(true,headers.authorization.slice(7))}`;response=await send();}
    if(response.status===401)await this.options.onUnauthorized?.();
    if(response.status===409){let error='';try{error=parse(response).error;}catch{}if(error==='library_epoch_mismatch'){this.epoch=undefined;await this.options.onEpochMismatch?.();throw Error('library_epoch_mismatch');}}
    if(response.status===426){let code='client_upgrade_required';try{const value=parse(response).error;if(typeof value==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(value))code=value;}catch{}throw new CloudRequestError(426,code);}
    return response;
  }
  async bootstrap(): Promise<CloudBootstrap> { const j = requireOk(await this.request("POST", "/functions/v1/cloud/bootstrap", {})); this.observeRequiredFeatures(j); return { ...parseContentState(j),libraryEpoch:j.libraryEpoch,keyVersionFloor:j.keyVersionFloor,keyCommitments:j.keyCommitments, member: member(j.member), devices: (j.devices || []).map((v: any): RegisteredCloudDevice => ({ deviceId: String(v.deviceId), platform: String(v.platform), displayName: String(v.displayName || ""), publicKeySpki: String(v.publicKeySpki || ""), keyVersion: Number(v.keyVersion || 1), lastSequence: Number(v.lastSequence || 0), attestation:v.attestation,attestationKeyVersion:v.attestationKeyVersion,revokedAt: v.revokedAt == null ? null : String(v.revokedAt) })), keyEnvelopes: (j.keyEnvelopes || []).map((v: any) => ({ id: String(v.id), recipientType: String(v.recipientType), recipientDeviceId: v.recipientDeviceId == null ? null : String(v.recipientDeviceId), envelope: { algorithm: String(v.algorithm), keyVersion: Number(v.keyVersion), wrappedKeyBase64: String(v.wrappedKeyBase64), nonceBase64: String(v.nonceBase64), ephemeralPublicKeySpki: v.ephemeralPublicKeySpki == null ? null : String(v.ephemeralPublicKeySpki) } })) }; }
  async registerDevice(deviceId: string, displayName: string, publicKeySpki: string, keyVersion: number,attestation?:{keyVersion:number;mac:string}): Promise<void> { requireOk(await this.request("POST", "/functions/v1/cloud/devices/register", { deviceId, platform: "watch", displayName, publicKeySpki, keyVersion,...(attestation?{attestation:attestation.mac,attestationKeyVersion:attestation.keyVersion}:{}), capabilities: { ...cloudFormatCapabilities,cloudFormatR48WriteV1:this.options.r48WriteV1===true,snapshotSchema: 2, cloudRelay: true, rtosProtocolReserved: true } })); }
  async formatCapabilities(){const value=requireOk(await this.request('GET','/functions/v1/cloud/format-capabilities'));this.observeRequiredFeatures(value);return {...value,local:{...cloudFormatCapabilities,cloudFormatR48WriteV1:this.options.r48WriteV1===true}};}
  async revokeOwnOwnership(deviceId:string){const j=requireOk(await this.request('POST',`/functions/v1/cloud/devices/${encodeURIComponent(deviceId)}/revoke`,{}));if(j.deviceId!==deviceId||j.revoked!==true||j.ownershipReleased!==true)throw Error('pairing_release_unverified');}
  async revokeDevice(deviceId:string){requireOk(await this.request('POST',`/functions/v1/cloud/devices/${encodeURIComponent(deviceId)}/revoke`,{}));}
  async approvalCreate(deviceId:string,commitment:string){return requireOk(await this.request('POST','/functions/v1/cloud/approvals/v2',{deviceId,commitment})) as {requestId:string;expiresAt:number};}
  async approvalGet(id:string){return requireOk(await this.request('GET',`/functions/v1/cloud/approvals/v2/${encodeURIComponent(id)}`));}
  async approvalReveal(id:string,requesterNonce:string){requireOk(await this.request('POST',`/functions/v1/cloud/approvals/v2/${encodeURIComponent(id)}/reveal`,{requesterNonce}));}
  async approvalCancel(id:string){requireOk(await this.request('POST',`/functions/v1/cloud/approvals/v2/${encodeURIComponent(id)}/cancel`,{}));}
  async records(after:string,deviceId:string):Promise<import('./records').RecordPage>{const j=requireOk(await this.request('GET',`/functions/v1/cloud/records?after=${encodeURIComponent(after)}&limit=50&deviceId=${encodeURIComponent(deviceId)}`));this.contentResponse(j);return j;}
  async pushRecords(items:import('./records').RecordWrite[]):Promise<{formatVersion:1;items:{recordId:string;revision:string}[]}>{const r48=this.options.r48WriteV1===true;if(r48&&!await this.refreshR48WriteGate())throw Error('cloud_format_write_disabled');return requireOk(await this.request('POST','/functions/v1/cloud/records',{formatVersion:1,items},undefined,r48));}
  async snapshotHeads(): Promise<CloudSnapshotHead[]> { const j = requireOk(await this.request("GET", "/functions/v1/cloud/snapshots/heads")); this.contentResponse(j);return (j.heads || []).map(head); }
  async snapshot(id:string):Promise<{manifestUrl:string;chunks:{sha256:string;sizeBytes:number;signedUrl:string}[]}> {
    const j=requireOk(await this.request("GET",`/functions/v1/cloud/snapshots/${encodeURIComponent(id)}`));
    return {manifestUrl:String(j.snapshot.manifestSignedUrl),chunks:(j.chunks||[]).map((v:any)=>({sha256:String(v.sha256),sizeBytes:Number(v.sizeBytes),signedUrl:String(v.signedUrl)}))};
  }
  async download(url:string,size:number,sha256:string):Promise<Uint8Array>{
    this.guard.require();if(!/^https:\/\//.test(url)||!Number.isSafeInteger(size)||size<0||size>8*1024*1024||!/^[0-9a-f]{64}$/.test(sha256))throw Error("无效云对象");
    // Signed storage URLs must never receive account credentials.
    let r:HttpResponse;try{r=await this.http.request({method:"GET",url,headers:{}});}catch(error){
      // Preserve cancellation, window and capability errors. Only an actual
      // transport timeout becomes an object timeout; never serialize its text.
      if(!snapshotDeferred(error)&&cloudFormatFailure(error)==='timeout'&&(error as {code?:unknown})?.code!=='cloud_sync_deadline_exceeded'&&String(error)!=='Error: cloud_sync_deadline_exceeded')throw new CloudRequestError(408,'cloud_snapshot_object_timeout');
      throw error;
    }
    if(r.status<200||r.status>=300){const reason=r.status===404||r.status===410?'missing':r.status===401||r.status===403?'unauthorized':r.status===408||r.status===504?'timeout':r.status===429?'rate_limited':r.status>=300&&r.status<400?'redirect':undefined;throw new CloudRequestError(r.status,reason?'cloud_snapshot_object_'+reason:'cloud_snapshot_download_failed');}
    if(r.body.length!==size||await this.crypto.sha256(r.body)!==sha256)throw new CloudRequestError(502,'cloud_snapshot_object_integrity');return r.body;
  }
  async reserveSnapshot(snapshot: EncryptedCloudSnapshot, retentionDays: number | null = null): Promise<CloudSnapshotReservation> { this.guard.require(); const r48=this.options.r48WriteV1===true||!!snapshot.manifest.features?.incompat?.some(f=>f.startsWith('r48.'))||snapshot.manifest.objects?.some(o=>!!o.entryRef||!!o.objectKeyEnvelope);if(r48&&!await this.refreshR48WriteGate())throw Error('cloud_format_write_disabled');const manifestSha256 = await this.crypto.sha256(snapshot.encryptedManifest); const chunks = snapshot.manifest.allChunks.filter((v, i, a) => a.findIndex(x => x.ciphertextSha256 === v.ciphertextSha256) === i).map(v => ({ sha256: v.ciphertextSha256, sizeBytes: v.ciphertextBytes })); const m = snapshot.manifest; const j = requireOk(await this.request("POST", "/functions/v1/cloud/snapshots/reserve", { contentLayout:3,snapshotId: m.snapshotId, sourceDeviceId: m.sourceDeviceId, deviceSequence: m.deviceSequence, keyVersion: m.keyVersion, manifest: { sha256: manifestSha256, sizeBytes: snapshot.encryptedManifest.length }, parentHeads: m.parentHeads, observedHeads: m.observedHeads, retentionDays, chunks },undefined,r48));if(r48)this.r48Snapshots.add(m.snapshotId); return { snapshotId: String(j.snapshotId), reservedBytes: Number(j.reservedBytes), missingObjects: (j.missingObjects || []).map((v: any): CloudUploadObject => ({ transport:v.transport,uploadUrl:v.uploadUrl,uploadMethod:v.uploadMethod,reservationId:v.reservationId,kind: String(v.kind), sha256: String(v.sha256), sizeBytes: Number(v.sizeBytes), objectPath: String(v.objectPath), signedUrl: String(v.signedUrl), token: String(v.token), tusEndpoint: String(v.tusEndpoint), bucketName: String(v.bucketName) })) }; }
  /** Only v2 epoch-proxy targets receive account credentials; arbitrary signed/TUS URLs never do. */
  async uploadObject(target:CloudUploadObject,bytes:Uint8Array):Promise<void>{
    this.guard.require();const prefix=this.options.baseUrl.replace(/\/$/,'')+'/functions/v1/cloud/uploads/',url=target.uploadUrl??target.signedUrl,id=url.startsWith(prefix)?url.slice(prefix.length):'';
    if(target.transport!=='epoch-proxy'||target.uploadMethod!=='PUT'||!id||! /^[A-Za-z0-9_-]{1,128}$/.test(id)||target.reservationId!==id)throw Error('无效纪元上传目标');
    if(bytes.length!==target.sizeBytes||bytes.length>8*1024*1024||await this.crypto.sha256(bytes)!==target.sha256)throw Error('待上传云对象校验失败');
    const r48=this.options.r48WriteV1===true;if(r48&&!await this.refreshR48WriteGate())throw Error('cloud_format_write_disabled');requireOk(await this.request('PUT','/functions/v1/cloud/uploads/'+id,undefined,bytes,r48));
  }
  async completeSnapshot(snapshotId: string, chunkHashes: string[]): Promise<any> {const r48=this.options.r48WriteV1===true||this.r48Snapshots.has(snapshotId);if(r48&&!await this.refreshR48WriteGate())throw Error('cloud_format_write_disabled');const result=requireOk(await this.request('POST','/functions/v1/cloud/snapshots/complete',{snapshotId,chunkHashes},undefined,r48));this.r48Snapshots.delete(snapshotId);return result;}
  async acknowledge(snapshotId: string, deviceId: string, result = "applied"): Promise<void> { requireOk(await this.request("POST", `/functions/v1/cloud/snapshots/${encodeURIComponent(snapshotId)}/ack`, { deviceId, result })); }
  async resolveRssSource(sourceUrl: string, mode: "all" | "recent128" = "recent128"): Promise<RssInventory> { const r = requireOk(await this.request("POST", "/functions/v1/rss/sources/resolve", { url: sourceUrl })); if(typeof r.source?.id!=='string'||!r.source.id.trim())throw Error('cloud_source_invalid');const sourceId = r.source.id; const limit = mode === "all" ? "all" : "128"; const j = requireOk(await this.request("GET", `/functions/v1/rss/sources/${encodeURIComponent(sourceId)}/entries?limit=${limit}`)); const source = j.source || {}; return { sourceId, url: sourceUrl, title: String(source.title || ""), description: String(source.description || ""), siteUrl: source.siteUrl == null ? null : String(source.siteUrl), imageUrl: source.imageUrl == null ? null : String(source.imageUrl), items: (j.entries || []).map((e: any) => { const id = String(e.id); return { dedupKey:e.dedupKey==null?undefined:String(e.dedupKey),identityLink:e.link==null?null:String(e.link),audioUrl:e.audioUrl??null,videoUrl:e.videoUrl??null,publishedAt:e.publishedAt??null,url: e.link == null ? `${sourceUrl}${sourceUrl.includes("?") ? "&" : "?"}watchrss_entry=${id}` : String(e.link), title: String(e.title || ""), excerpt: String(e.excerpt || ""), contentHtml: e.contentHtml == null ? null : String(e.contentHtml), contentText: e.contentText == null ? "" : String(e.contentText), imageUrl: e.imageUrl == null ? null : String(e.imageUrl), guid: e.guid == null ? "" : String(e.guid), contentHash: e.contentHash == null ? null : String(e.contentHash) }; }) }; }
}
