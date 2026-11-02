import type {CloudChunk} from './codec';
type Result={bytes:Uint8Array;error?:never}|{error:unknown;bytes?:never};
/** Exactly one immutable ciphertext; never publishes decoded/application state. Close drains the host
 * request before its caller releases the lease. Rejections are always observed. */
export class ChunkLookahead {
 private pending?:{hash:string;result:Promise<Result>};private closed=false;
 constructor(private fetch:(chunk:CloudChunk)=>Promise<Uint8Array>,private current:()=>Promise<void>){}
 start(chunk:CloudChunk){
  if(this.closed||this.pending)return;
  const result=(async():Promise<Result>=>{try{await this.current();if(this.closed)throw Error('cloud_sync_suspended');const bytes=await this.fetch(chunk);await this.current();if(this.closed)throw Error('cloud_sync_suspended');return {bytes};}catch(error){return {error};}})();
  this.pending={hash:chunk.ciphertextSha256,result};
 }
 async take(chunk:CloudChunk){
  const pending=this.pending;if(!pending||pending.hash!==chunk.ciphertextSha256)return this.fetch(chunk);
  this.pending=undefined;const result=await pending.result;await this.current();if('error'in result)throw result.error;return result.bytes!;
 }
 async close(){this.closed=true;const pending=this.pending;this.pending=undefined;if(pending)await pending.result;}
}
