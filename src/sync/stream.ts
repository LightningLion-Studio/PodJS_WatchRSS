import {StreamFrameConnection as FrameConnection} from '@podjs/framework/frame-stream';
import {strictJson} from './library-binary/wire';
import {decodeFrameAsync,decodeSyncUtf8,encodeFrameAsync,MAX_FRAME_BYTES,type JsonObject} from './protocol.ts';
import {decodeSpooledSyncFrame} from './spooled-manifest';
import type {SyncFrameConnection} from './session.ts';
import type {FrameByteStream} from '@podjs/framework/frame-stream';
import type {CodecWorkOptions} from '@podjs/framework/bytes';
export {TRANSFER_CHUNK_BYTES,type FrameByteStream as SyncByteStream} from '@podjs/framework/frame-stream';

async function decode(frame:Uint8Array,work:CodecWorkOptions):Promise<JsonObject>{
 const value=await decodeFrameAsync(frame,work);
 return value.action==='syncLibraryBinary'?strictJson(decodeSyncUtf8(frame.subarray(4))):value;
}
export class StreamFrameConnection extends FrameConnection<JsonObject> implements SyncFrameConnection {
 constructor(stream:FrameByteStream,now=Date.now,chunkBytes=64*1024){
  super(stream,{maxFrameBytes:MAX_FRAME_BYTES,chunkBytes,encode:encodeFrameAsync,decode,
   spoolAboveBytes:32*1024,spoolIdleTimeoutMs:20_000,decodeSpool:(spool,work)=>decodeSpooledSyncFrame(spool,work,decode)},now);
 }
}
