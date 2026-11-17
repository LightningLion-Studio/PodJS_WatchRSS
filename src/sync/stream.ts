import {StreamFrameConnection as FrameConnection} from '@podjs/framework/frame-stream';
import {strictJson} from './library-binary/wire';
import {decodeFrameAsync,decodeSyncUtf8,encodeFrameAsync,MAX_FRAME_BYTES,type JsonObject} from './protocol.ts';
import type {SyncFrameConnection} from './session.ts';
import type {FrameByteStream} from '@podjs/framework/frame-stream';
export {TRANSFER_CHUNK_BYTES,type FrameByteStream as SyncByteStream} from '@podjs/framework/frame-stream';
export class StreamFrameConnection extends FrameConnection<JsonObject> implements SyncFrameConnection {
 constructor(stream:FrameByteStream,now=Date.now,chunkBytes=64*1024){super(stream,{maxFrameBytes:MAX_FRAME_BYTES,chunkBytes,encode:encodeFrameAsync,decode:async(frame,work)=>{const value=await decodeFrameAsync(frame,work);return value.action==='syncLibraryBinary'?strictJson(decodeSyncUtf8(frame.subarray(4))):value;}},now);}
}
