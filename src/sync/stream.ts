import {StreamFrameConnection as FrameConnection} from '@podjs/framework/frame-stream';
import {decodeFrameAsync,encodeFrameAsync,MAX_FRAME_BYTES,type JsonObject} from './protocol.ts';
import type {SyncFrameConnection} from './session.ts';
import type {FrameByteStream} from '@podjs/framework/frame-stream';
export {TRANSFER_CHUNK_BYTES,type FrameByteStream as SyncByteStream} from '@podjs/framework/frame-stream';
export class StreamFrameConnection extends FrameConnection<JsonObject> implements SyncFrameConnection {
 constructor(stream:FrameByteStream,now=Date.now){super(stream,{maxFrameBytes:MAX_FRAME_BYTES,encode:encodeFrameAsync,decode:decodeFrameAsync},now);}
}
