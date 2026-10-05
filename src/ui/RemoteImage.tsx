import {createLogConsole} from '../logs/app-logger.ts';
const logConsole=createLogConsole('RemoteImage');
import {managedCache} from "../cache/host.ts";
import type {CachedImage} from "../cache/managed.ts";
import { imageFitRect } from "./image-fit.ts";
import { createEffect, createSignal, onCleanup } from "solid-js";
import { Image, View, type NodeMirror } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { getDisplayMetrics } from "@podjs/framework/watch";
import { base64ToBytes, hostOperation } from "@podjs/framework/services";

export interface RemoteImageProps {
  url: string;
  inline?:boolean;
  cacheBucket?:"images"|"bili-preview";
  filePath?: string;
  width: number;
  height: number;
  class?: string;
  headers?: Record<string, string>;
  fit?: "stretch" | "cover" | "contain";
  onSize?: (width:number,height:number)=>void;
  onError?: (error:unknown)=>void;
}

interface DecodeResult { path: string; width: number; height: number; sourceWidth?:number; sourceHeight?:number }
interface ChunkResult { dataBase64: string; offset: number; size: number; eof: boolean }
interface NativeTextureFileHost { uploadTextureFile?: (path:string,width:number,height:number,psm:number)=>number }
interface Entry {
  key: string;
  refs: number;
  nodes: Map<NodeMirror, {onSize?: (width:number,height:number)=>void;onError?: (error:unknown)=>void}>;
  error?:unknown;
  sourceWidth?:number;
  sourceHeight?:number;
  cancelled: boolean;
  started: boolean;
  handle: number;
  inputPath?: string;
  outputPath?: string;
  current?: { cancel(): void };
  url: string;
  inline?:boolean;
  cacheBucket?:"images"|"bili-preview";
  filePath?: string;
  headers?: Record<string, string>;
  maxDimension: number;
}

const MAX_DECODED_BYTES = 512 * 512 * 4;
const MAX_CONCURRENT = 3;
let loggedScale = false;
const entries = new Map<string, Entry>();
const queue: Entry[] = [];
let active = 0;

function normalizedHeaders(headers?: Record<string, string>): string {
  if (!headers) return "";
  return Object.keys(headers).sort().map(key => `${key.toLowerCase()}:${headers[key]}`).join("\n");
}

function removeFile(path: string | undefined): void {
  if (!path) return;
  void hostOperation("file.delete", { path }).result.catch(() => {});
}

function decodedSize(decoded:DecodeResult):number {
  if (!Number.isInteger(decoded.width) || !Number.isInteger(decoded.height)
      || decoded.width < 1 || decoded.height < 1 || decoded.width > 512 || decoded.height > 512
      || (decoded.width & (decoded.width - 1)) !== 0 || (decoded.height & (decoded.height - 1)) !== 0) {
    throw new Error("远程图片尺寸无效");
  }
  const size = decoded.width * decoded.height * 4;
  if (size > MAX_DECODED_BYTES) throw new Error("远程图片解码结果过大");
  return size;
}

function nativeTextureFileHost():NativeTextureFileHost|undefined {
  return (globalThis as {pod?:NativeTextureFileHost}).pod;
}

async function readDecoded(entry: Entry, decoded: DecodeResult, size: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const operation = hostOperation<ChunkResult>("file.read", { path: decoded.path, offset, maxBytes: Math.min(256 * 1024, size - offset) });
    entry.current = operation;
    const chunk = await operation.result;
    if (entry.cancelled) throw new Error("cancelled");
    const data = base64ToBytes(chunk.dataBase64);
    if (!data.length || data.length > size - offset || chunk.size !== size) throw new Error("远程图片数据不完整");
    bytes.set(data, offset);
    offset += data.length;
  }
  return bytes;
}

async function load(entry: Entry): Promise<void> {
  let cached:CachedImage|undefined;
  try {
    let sourcePath=entry.filePath;
    if(!sourcePath){
      const request=managedCache.acquire(entry.url,entry.headers,entry.inline,entry.cacheBucket);
      entry.current=request;cached=await request.result;sourcePath=cached.path;if(entry.cancelled)return;
    }
    const decodeOperation = hostOperation<DecodeResult>("image.decode", { path: sourcePath, maxDimension: entry.maxDimension });
    entry.current = decodeOperation;
    const decoded = await decodeOperation.result;
    entry.outputPath = decoded.path;
    if (entry.cancelled) return;
    const size=decodedSize(decoded);
    const nativeUpload=nativeTextureFileHost()?.uploadTextureFile;
    let handle:number;
    if(typeof nativeUpload==="function"){
      // A supporting host consumes the generated path on every outcome.
      entry.outputPath=undefined;
      const result=nativeUpload(decoded.path,decoded.width,decoded.height,3);
      handle=typeof result==="number"&&Number.isInteger(result)?result:-1;
    }else{
      const rgba = await readDecoded(entry, decoded, size);
      if (entry.cancelled) return;
      handle = getOps().uploadTexture(rgba, decoded.width, decoded.height, 3);
    }
    if (handle < 0) throw new Error("远程图片纹理创建失败");
    if (entry.cancelled) { getOps().freeTexture?.(handle); return; }
    entry.handle = handle;
    entry.sourceWidth=decoded.sourceWidth??decoded.width;entry.sourceHeight=decoded.sourceHeight??decoded.height;
    for (const [node,callbacks] of entry.nodes) {getOps().setImage(node.id, handle);callbacks.onSize?.(entry.sourceWidth,entry.sourceHeight);}
  } catch (error) {
    if (!entry.cancelled) {entry.error=error;logConsole.warn('RemoteImage request failed');for(const callbacks of entry.nodes.values())callbacks.onError?.(error);}
  } finally {
    entry.current = undefined;
    cached?.release();
    removeFile(entry.inputPath);
    removeFile(entry.outputPath);
  }
}

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length) {
    const entry = queue.shift()!;
    if (entry.cancelled || entry.started) continue;
    entry.started = true;
    active++;
    void load(entry).finally(() => { active--; pump(); });
  }
}

/** Released-but-finished textures, oldest first, bounded by decoded bytes. */
const RETAINED_BYTES = 8 * 1024 * 1024;
const retained: Entry[] = [];
function textureBytes(entry: Entry) { return entry.maxDimension * entry.maxDimension * 4; }
function dispose(entry: Entry): void {
  entries.delete(entry.key);
  entry.cancelled = true;
  entry.current?.cancel();
  if (entry.handle >= 0) getOps().freeTexture?.(entry.handle);
  removeFile(entry.inputPath);
  removeFile(entry.outputPath);
}
function retain(entry: Entry): void {
  retained.push(entry);
  let total = retained.reduce((sum, item) => sum + textureBytes(item), 0);
  while (total > RETAINED_BYTES && retained.length > 1) { const oldest = retained.shift()!; total -= textureBytes(oldest); dispose(oldest); }
}
/** Free every retained texture (memory pressure, tests). */
export function releaseRetainedRemoteImages(): void { while (retained.length) dispose(retained.shift()!); }
function revive(entry: Entry): void { const index = retained.indexOf(entry); if (index >= 0) retained.splice(index, 1); }

export function bindRemoteImage(props: RemoteImageProps, node: NodeMirror, onSize?: (width:number,height:number)=>void): () => void {
  // Decode at device pixels (logical × scale), like native Coil sizing to the view; capped by the 512px texture budget.
  const metrics = getDisplayMetrics(), pixelScale = metrics.logicalWidth > 0 ? metrics.physicalWidth / metrics.logicalWidth : 1;
  // The host texture is the largest power of two <= maxDimension, so round the request up.
  const devicePx = Math.ceil(Math.max(props.width, props.height) * pixelScale);
  const maximum = Math.max(1, Math.min(512, 2 ** Math.ceil(Math.log2(Math.max(1, devicePx)))));
  if (!loggedScale) { loggedScale = true; logConsole.info(`RemoteImage scale=${pixelScale} request=${props.width}x${props.height} maxDimension=${maximum}`); }
  const key = `${props.cacheBucket??"images"}\u0000${props.inline?"inline":"general"}\u0000${props.filePath??""}\u0000${props.url}\u0000${maximum}\u0000${normalizedHeaders(props.headers)}`;
  let entry = entries.get(key);
  if (!entry) {
    entry = { key, refs: 0, nodes: new Map(), cancelled: false, started: false, handle: -1,
      url: props.url, inline:props.inline,cacheBucket:props.cacheBucket,filePath:props.filePath, headers: props.headers, maxDimension: maximum };
    entries.set(key, entry);
    queue.push(entry);
    pump();
  }
  if (entry.refs === 0) revive(entry);
  entry.refs++;
  entry.nodes.set(node,{onSize,onError:props.onError});
  if(entry.error!==undefined)props.onError?.(entry.error);
  if (entry.handle >= 0) {getOps().setImage(node.id, entry.handle);onSize?.(entry.sourceWidth!,entry.sourceHeight!);}
  return () => {
    entry!.nodes.delete(node);
    getOps().setImage(node.id, -1);
    if (--entry!.refs > 0) return;
    // Virtualized rows unbind on scroll-out; keep finished textures briefly so scrolling back
    // does not re-run download/decode/read/upload (native Coil keeps a memory cache too).
    if (entry!.handle >= 0) { retain(entry!); return; }
    dispose(entry!);
  };
}

/** Native remote image with bounded download, decode, GPU upload and cleanup. */
export function RemoteImage(props: RemoteImageProps) {
  let node: NodeMirror | undefined;
  const [size,setSize]=createSignal({width:props.width,height:props.height});
  createEffect(() => {
    if (!node || !props.url) return;
    const release = bindRemoteImage(props, node,(width,height)=>{setSize({width,height});props.onSize?.(width,height);});
    onCleanup(release);
  });
  const rect=()=>imageFitRect(props.width,props.height,size().width,size().height,props.fit);
  return props.fit && props.fit!=="stretch"
    ? <View class={props.class} style={{width:props.width,height:props.height}}><View class="relative overflow-hidden" style={{width:props.width,height:props.height}}><Image ref={value => { node = value; }} class="absolute" style={{insetL:rect().left,insetT:rect().top,width:rect().width,height:rect().height}} /></View></View>
    : <Image ref={value=>{node=value;}} class={props.class} style={{width:props.width,height:props.height}}/>;
}

/** Test-only visibility into resource bounds, without exposing cache entries. */
export function remoteImageResourceCounts(): Readonly<{ active: number; queued: number; cached: number }> {
  return Object.freeze({ active, queued: queue.filter(item => !item.cancelled && !item.started).length, cached: entries.size });
}
