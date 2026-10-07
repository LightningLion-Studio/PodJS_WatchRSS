import {encodeUtf8,encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import {encodeUtf8Async,decodeUtf8Async,type CodecWorkOptions} from '@podjs/framework/bytes';
import {parseWireJson} from "./wire-json.ts";
/** Pure TypeScript representation of the Android BluetoothSyncProtocol and the
 * wire-level parts of LibrarySyncPayload. It deliberately does not open a
 * Bluetooth socket or implement a sync manager. */

export const SERVICE_NAME = "WatchRSS Bluetooth Sync";
export const SERVICE_UUID = "bb2f0b7d-8f2f-4a96-95b2-d2c91d58a861";
export const ACTION_SYNC_LIBRARY = "syncLibrary";
export const ACTION_SYNC_SESSION = "syncSession";
export const ACTION_ACK = "ack";
export const ACTION_CLEAR_LIBRARY = "clearLibrary";
export const LIBRARY_MODE_MERGE = "merge";
export const LIBRARY_MODE_PHONE_TO_WATCH_REPLACE = "phoneToWatchReplace";
export const LIBRARY_MODE_WATCH_TO_PHONE_REPLACE = "watchToPhoneReplace";
export const PROTOCOL_VERSION = 14;
export const MIN_SUPPORTED_PHONE_PROTOCOL_VERSION = 13;
export const LEGACY_PROTOCOL_VERSION = 4;
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const LENGTH_PREFIX_BYTES = 4;
export const CHUNK_SIZE_BYTES = 128 * 1024;
export const PHASE_CURSOR = "cursor";
export const PHASE_MANIFEST = "manifest";
export const PHASE_PROBE = "probe";
export const PHASE_ARTICLES = "articles";
export const PHASE_COMPLETE = "complete";

export type JsonObject = Record<string, unknown>;
export type Sha256 = (bytes: Uint8Array) => Promise<string>;

const utf8Encode=(value:string)=>encodeUtf8(value,'strict');

export function decodeSyncUtf8(bytes: Uint8Array): string {
  const parts:string[]=[],units:number[]=[];
  const flush=()=>{if(units.length){parts.push(String.fromCharCode(...units));units.length=0;}};
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i++]; let code: number; let count: number;
    if (first <= 0x7f) { code = first; count = 0; }
    else if (first >= 0xc2 && first <= 0xdf) { code = first & 0x1f; count = 1; }
    else if (first >= 0xe0 && first <= 0xef) { code = first & 0x0f; count = 2; }
    else if (first >= 0xf0 && first <= 0xf4) { code = first & 0x07; count = 3; }
    else throw new Error("invalid UTF-8");
    for (let j = 0; j < count; j++) { const next = bytes[i++]; if ((next & 0xc0) !== 0x80) throw new Error("invalid UTF-8"); code = (code << 6) | (next & 0x3f); }
    if ((count === 1 && code < 0x80) || (count === 2 && code < 0x800) || (count === 3 && code < 0x10000) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new Error("invalid UTF-8");
    if (code <= 0xffff) units.push(code); else { const n = code - 0x10000; units.push(0xd800 + (n >> 10), 0xdc00 + (n & 0x3ff)); }
    if(units.length>=2048)flush();
  }
  flush();return parts.join("");
}

/** Android uses DataOutputStream.writeInt: signed big-endian length prefix. */
export function encodeFrame(payload: JsonObject): Uint8Array {
  const body = utf8Encode(JSON.stringify(payload));
  if (body.byteLength < 1 || body.byteLength > MAX_FRAME_BYTES) {
    throw new RangeError(`sync frame length out of range: ${body.byteLength}`);
  }
  const frame = new Uint8Array(LENGTH_PREFIX_BYTES + body.byteLength);
  new DataView(frame.buffer).setInt32(0, body.byteLength, false);
  frame.set(body, LENGTH_PREFIX_BYTES);
  return frame;
}

/** Transport callers yield between bounded encoding pieces and can close/cancel. */
export async function encodeFrameAsync(payload:JsonObject,options:CodecWorkOptions={}):Promise<Uint8Array>{
  const body=await encodeUtf8Async(JSON.stringify(payload),'strict',options);
  if(body.length<1||body.length>MAX_FRAME_BYTES)throw new RangeError(`sync frame length out of range: ${body.length}`);
  const frame=new Uint8Array(4+body.length);new DataView(frame.buffer).setInt32(0,body.length,false);frame.set(body,4);return frame;
}

export function decodeFrame(frame: Uint8Array): JsonObject {
  if (frame.byteLength < LENGTH_PREFIX_BYTES) throw new Error("truncated sync frame prefix");
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getInt32(0, false);
  if (length < 1 || length > MAX_FRAME_BYTES) throw new RangeError(`sync frame length out of range: ${length}`);
  if (frame.byteLength !== LENGTH_PREFIX_BYTES + length) throw new Error("truncated or trailing sync frame bytes");
  return parseWireJson(decodeSyncUtf8(frame.subarray(LENGTH_PREFIX_BYTES)));
}

export async function decodeFrameAsync(frame:Uint8Array,options:CodecWorkOptions={}):Promise<JsonObject>{
  if(frame.length<4)throw new Error('truncated sync frame prefix');
  const length=new DataView(frame.buffer,frame.byteOffset,frame.byteLength).getInt32(0,false);
  if(length<1||length>MAX_FRAME_BYTES)throw new RangeError(`sync frame length out of range: ${length}`);
  if(frame.length!==4+length)throw new Error('truncated or trailing sync frame bytes');
  return parseWireJson(await decodeUtf8Async(frame.subarray(4),options));
}

/** Incremental reassembler for arbitrary transport read boundaries. */
export class FrameDecoder {
  private readonly header=new Uint8Array(4);
  private headerSize=0;
  private body:Uint8Array|null=null;
  private bodySize=0;
  private failed=false;
  push(bytes:Uint8Array):JsonObject[]{
    if(this.failed)throw new Error("sync stream already failed");
    const frames:JsonObject[]=[];let offset=0;
    try{
      while(offset<bytes.length){
        if(!this.body){
          const count=Math.min(4-this.headerSize,bytes.length-offset);this.header.set(bytes.subarray(offset,offset+count),this.headerSize);this.headerSize+=count;offset+=count;
          if(this.headerSize<4)break;
          const length=new DataView(this.header.buffer).getInt32(0,false);
          if(length<1||length>MAX_FRAME_BYTES)throw new RangeError(`sync frame length out of range: ${length}`);
          this.body=new Uint8Array(length);this.bodySize=0;
        }
        const count=Math.min(this.body.length-this.bodySize,bytes.length-offset);this.body.set(bytes.subarray(offset,offset+count),this.bodySize);offset+=count;this.bodySize+=count;
        if(this.bodySize===this.body.length){frames.push(parseWireJson(decodeSyncUtf8(this.body)));this.body=null;this.headerSize=0;this.bodySize=0;}
      }
      return frames;
    }catch(error){this.failed=true;this.body=null;throw error;}
  }
  finish():void{if(this.failed)throw new Error("sync stream already failed");if(this.headerSize||this.body)throw new Error("truncated sync stream");}
}

export interface NegotiatedProtocol { version: 14; remoteVersion: number; legacy: boolean; }

export function negotiateLibraryProtocol(remoteVersion: number): NegotiatedProtocol {
  if (!Number.isInteger(remoteVersion) || remoteVersion < MIN_SUPPORTED_PHONE_PROTOCOL_VERSION) {
    throw new Error(`phone protocol ${remoteVersion} is below minimum ${MIN_SUPPORTED_PHONE_PROTOCOL_VERSION}`);
  }
  return { version: PROTOCOL_VERSION, remoteVersion, legacy: remoteVersion <= LEGACY_PROTOCOL_VERSION };
}

export interface ProbeCapabilities {
  supportsManifestBatches?: boolean;
  supportsReaderPresets?: boolean;
  supportsReaderAssets?: boolean;
  supportsResourceChunkAck?: boolean;
  supportsReaderPresetPreview?: boolean;
  supportsPersistentSession?: boolean;
  supportsTransferByteProgress?: boolean;
}

export function buildProbeResponse(deviceId: string, capabilities: ProbeCapabilities = {}, watchCapabilities?: JsonObject): JsonObject {
  const payload: JsonObject = {
    success: true, version: PROTOCOL_VERSION, action: ACTION_SYNC_LIBRARY, phase: PHASE_PROBE,
    supportsManifestBatches: capabilities.supportsManifestBatches === true,
    supportsReaderPresets: capabilities.supportsReaderPresets === true,
    supportsReaderAssets: capabilities.supportsReaderAssets === true,
    supportsResourceChunkAck: capabilities.supportsResourceChunkAck === true,
    supportsReaderPresetPreview: capabilities.supportsReaderPresetPreview === true,
    supportsPersistentSession: capabilities.supportsPersistentSession === true,
    supportsTransferByteProgress: capabilities.supportsTransferByteProgress === true, deviceId,
  };
  if (watchCapabilities) payload.watchCapabilities = watchCapabilities;
  return payload;
}

export function validateLibraryPayload(payload: JsonObject): void {
  if (payload.action !== ACTION_SYNC_LIBRARY) throw new Error("unexpected sync action");
  const version = payload.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < MIN_SUPPORTED_PHONE_PROTOCOL_VERSION) {
    throw new Error(`unsupported library protocol version: ${String(version)}`);
  }
  const phase = payload.phase;
  if (![PHASE_CURSOR, PHASE_MANIFEST, PHASE_PROBE, PHASE_ARTICLES, PHASE_COMPLETE].includes(String(phase))) {
    throw new Error(`invalid library sync phase: ${String(phase)}`);
  }
}

export interface Chunk { index: number; hash: string; data: string; }

export const decodeChunkData=decodeBase64;
export const encodeChunkData=encodeBase64;

export async function verifyChunk(chunk: Chunk, sha256: Sha256): Promise<Uint8Array> {
  const bytes = decodeChunkData(chunk.data);
  const actual = await sha256(bytes);
  if (actual !== chunk.hash) throw new Error(`chunk checksum mismatch: #${chunk.index}`);
  return bytes;
}

/** Merge chunks exactly like Android mergeBodyChunks: equal duplicates are OK. */
export async function mergeVerifiedChunks(chunks: readonly Chunk[], sha256: Sha256): Promise<Chunk[]> {
  const byIndex = new Map<number, Chunk>();
  const decoded=new Map<number,Uint8Array>();
  for (const chunk of chunks) {
    if (!Number.isInteger(chunk.index) || chunk.index < 0) throw new Error(`invalid chunk index: ${chunk.index}`);
    const bytes=await verifyChunk(chunk, sha256);
    const old = byIndex.get(chunk.index);
    if (old && (old.hash !== chunk.hash || decoded.get(chunk.index)!.length!==bytes.length || decoded.get(chunk.index)!.some((value,i)=>value!==bytes[i]))) {
      throw new Error(`conflicting duplicate chunk: #${chunk.index}`);
    }
    if (!old){byIndex.set(chunk.index, chunk);decoded.set(chunk.index,bytes);}
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}
