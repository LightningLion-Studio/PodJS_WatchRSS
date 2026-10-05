import {SyncEventLog} from '../logs/sync-events.ts';
import type {rfcomm,byteStreams,HostOperation} from '@podjs/framework/services';
import {decodeChunkData} from './protocol.ts';
import {StreamFrameConnection,type SyncByteStream} from './stream.ts';
import {LibrarySyncSession,type LibrarySessionRepository,type LibrarySessionOptions,type SessionActionResult} from './session.ts';
export const WATCH_RSS_RFCOMM_NAME='WatchRSS Bluetooth Sync';
export const WATCH_RSS_RFCOMM_UUID='bb2f0b7d-8f2f-4a96-95b2-d2c91d58a861';
export interface RfcommPorts {radio:typeof rfcomm;streams:typeof byteStreams}
export class HostSyncByteStream implements SyncByteStream {
 private closed=false;
 constructor(private readonly id:string,private readonly ports:RfcommPorts['streams']){}
 async read(maxBytes:number,timeoutMs:number){if(this.closed)throw new Error('Bluetooth stream closed');const value=await this.ports.read(this.id,maxBytes,timeoutMs).result;if(this.closed)throw new Error('Bluetooth stream closed');if(value.eof)return null;return decodeChunkData(value.dataBase64);}
 async write(bytes:Uint8Array){if(this.closed)throw new Error('Bluetooth stream closed');const result=await this.ports.write(this.id,bytes,120000).result;if(result.written!==bytes.length)throw new Error('Incomplete Bluetooth write');if(this.closed)throw new Error('Bluetooth stream closed');}
 async close(){if(this.closed)return;this.closed=true;await this.ports.close(this.id);}
}
/** One native-compatible secure RFCOMM session. Stop aborts pending
 * accept/read operations and releases every returned native handle. */
export class RfcommLibraryListener {
 private busy=false;private stopped=false;private pending:HostOperation<unknown>|undefined;private session:LibrarySyncSession|undefined;
 private listenerId:string|undefined;private stream:HostSyncByteStream|undefined;
 constructor(private readonly repository:LibrarySessionRepository,private readonly ports:RfcommPorts){}
 private check(){if(this.stopped)throw new Error('Bluetooth sync cancelled');}
 async start(options:LibrarySessionOptions & {acceptTimeoutMs?:number;onListening?:()=>void;onPeer?:(peer:{remoteName:string|null;remoteAddress:string})=>void}={}):Promise<SessionActionResult[]>{
  if(this.busy)throw new Error('Bluetooth sync already active');this.busy=true;this.stopped=false;const log=new SyncEventLog();log.event('server.acceptOnce.start',{timeoutMs:options.acceptTimeoutMs??120000});
  try{const status=await this.ports.radio.status();this.check();if(status.permission!=='granted')throw new Error('需要蓝牙连接权限');if(!status.available||!status.enabled)throw new Error('蓝牙未开启或设备不支持蓝牙');
   const listening=this.ports.radio.listen(WATCH_RSS_RFCOMM_NAME,WATCH_RSS_RFCOMM_UUID);this.pending=listening;const listener=await listening.result;this.listenerId=listener.id;this.check();log.event("server.listen.success",{elapsedMs:log.elapsed()});options.onListening?.();this.check();
   log.event("server.accept.start",{timeoutMs:options.acceptTimeoutMs??120000});const accepting=this.ports.radio.accept(listener.id,options.acceptTimeoutMs??120000);this.pending=accepting;const peer=await accepting.result;this.pending=undefined;this.stream=new HostSyncByteStream(peer.id,this.ports.streams);this.check();log.event("server.accept.success",{elapsedMs:log.elapsed()});log.event("server.client.accepted",{remoteName:"<redacted>",remoteAddress:"<redacted>"});
   await this.ports.radio.close(listener.id);this.listenerId=undefined;this.check();options.onPeer?.(peer);this.check();
   this.session=new LibrarySyncSession(new StreamFrameConnection(this.stream),this.repository,{...options,diagnosticLog:log});return await this.session.run();
  }catch(error){if(!this.stopped)log.event("server.acceptOnce.failed",{elapsedMs:log.elapsed(),message:"<redacted>"},"E");throw error;}finally{this.pending=undefined;this.session=undefined;try{await this.stream?.close();}finally{this.stream=undefined;try{if(this.listenerId)await this.ports.radio.close(this.listenerId);}finally{this.listenerId=undefined;this.busy=false;}}}
 }
 stop(){this.stopped=true;this.pending?.cancel();this.session?.cancel();void this.stream?.close().catch(()=>{});if(this.listenerId)void this.ports.radio.close(this.listenerId).catch(()=>{});}
}
