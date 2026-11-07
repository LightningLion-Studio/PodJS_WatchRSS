import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {ContentFiles} from '@podjs/framework/content-files';
import type {FrameByteStream} from '@podjs/framework/frame-stream';
import {WatchContentStore} from '../../src/sync-v2/content-store';
import {LocalObjectStore} from '../../src/sync-v2/local-objects';
import {LocalProofSession,type MemberStatus} from '../../src/sync-v2/local-proof';
import {objectCapability} from '../../src/sync-v2/local-capability';
import {WatchLocalObjectSession} from '../../src/sync-v2/local-session';
import {localObjectFrames,LocalReadClient} from '../../src/sync-v2/local-read';
import {openV2} from '../../src/sync-v2/sealed';
import {SqlFixture,cipher,scope} from './fixture';
import {FileHost,crypt,keys,pub} from './p3-fixture';
import {b64} from '../../src/sync-v2/wire';
export const scratch=process.env.WRSS_TEST_SCRATCH??join(tmpdir(),'wrss-p4-watch');
export const nonce=async()=>randomBytes(16).toString('hex');
export const watchId='a'.repeat(32),phoneId='b'.repeat(32),windowId='c'.repeat(32),sessionId='d'.repeat(32);
export const approved=async(deviceId:string)=>({deviceId,keyId:'e'.repeat(32),publicKey:b64(pub)});
export class MemoryStream implements FrameByteStream {
 peer!:MemoryStream;chunks:Uint8Array[]=[];wait?:()=>void;closed=false;writeBytes=0;writes=0;dropWriteAt?:number;fragment=7919;
 async read(max:number,_timeout:number){while(!this.chunks.length){if(this.closed)return null;await new Promise<void>(r=>this.wait=r);}const first=this.chunks[0]!,n=Math.min(max,this.fragment,first.length),part=first.slice(0,n);if(n===first.length)this.chunks.shift();else this.chunks[0]=first.subarray(n);return part;}
 async write(bytes:Uint8Array){if(this.closed)throw Error('socket_closed');this.writes++;if(this.dropWriteAt===this.writes){await this.close();throw Error('lost_ack');}this.writeBytes+=bytes.length;this.peer.chunks.push(bytes.slice());this.peer.wait?.();this.peer.wait=undefined;}
 async close(){this.closed=true;this.peer.closed=true;this.wait?.();this.peer.wait?.();}
}
export function streams(){const a=new MemoryStream(),b=new MemoryStream();a.peer=b;b.peer=a;return [a,b] as const;}
export async function cache(authenticate=(id:string,raw:Uint8Array)=>openV2(crypt,keys.id,keys.content,scope,id,raw).then(()=>{})){
 mkdirSync(scratch,{recursive:true});const root=mkdtempSync(join(scratch,'cache-')),db=new SqlFixture(join(root,'state.sqlite')),host=new FileHost(join(root,'files')),store=new WatchContentStore(db,cipher,new ContentFiles(host.request),{scope,fixture:'p4'});await store.init();
 const objects=new LocalObjectStore(store,scope,authenticate);return {root,db,host,store,objects,async close(){db.close();rmSync(root,{recursive:true,force:true});}};
}
export async function proofs(features:string[]=[],id=sessionId){
 const a=new LocalProofSession(id,keys.id,{scope,deviceId:watchId,nonce:await nonce(),features},async()=> 'active',()=>true),b=new LocalProofSession(id,keys.id,{scope,deviceId:phoneId,nonce:await nonce(),features},async()=> 'active',()=>true);await a.negotiate(b.hello);await b.negotiate(a.hello);await a.verify(b.proof(),[]);await b.verify(a.proof(),[]);return [a,b] as const;
}
export async function openLocal(objects:LocalObjectStore,extra:Partial<ConstructorParameters<typeof WatchLocalObjectSession>[0]>={},pair=streams(),member:()=>Promise<MemberStatus>=async()=> 'active'){
 const [clientStream,serverStream]=pair,id=await nonce(),features=extra.supportedFeatures??[],clientProof=new LocalProofSession(id,keys.id,{scope,deviceId:watchId,nonce:await nonce(),features},async()=> 'active',()=>true),serverProof=new LocalProofSession(id,keys.id,{scope,deviceId:phoneId,nonce:await nonce(),features},member,()=>true);
 const server=new WatchLocalObjectSession({enabled:true,objects,proof:serverProof,requiredFeatures:[],supportedFeatures:features,snapshot:async()=>({serverRevision:'0',refs:[],account:{commitOid:null,revision:'0',rollbackGeneration:'0'},historyFloorRevision:'0',checkpointOid:null}),nonce,closeSocket:()=>serverStream.close(),...extra}),responses:any[]=[];
 const old={readFrame:async()=>{throw Error('unexpected_old_read');},writeFrame:async(value:any)=>{responses.push(value);},close:()=>serverStream.close(),detachStream:()=>serverStream};
 await server.probe(objectCapability(scope,true,[],features));
 const request=async(action:string,body:any)=>{await server.handle({requestId:await nonce(),action,body},old);const r=responses.pop();if(!r?.ok)throw Error(r?.error?.code??'missing_response');return r.body;};
 const hello=await request('syncObjectsV2.negotiate',clientProof.hello);await clientProof.negotiate(hello);const proof=await request('syncObjectsV2.negotiate',{scope,proof:clientProof.proof()});await clientProof.verify(proof.proof,[]);
 const readWindowId=(await request('syncObjectsV2.negotiate',{scope,knownRefs:[],features:[]})).windowId;
 const switchId=await nonce();await request('syncObjectsV2.prepareFraming',{sessionId:id,framing:'WRP2',switchId});
 const running=server.handle({requestId:await nonce(),action:'syncObjectsV2.commitFraming',body:{switchId}},old).then(()=>null,e=>(e as Error).message);
 // Wait for the final complete legacy response, not a guessed byte boundary.
 while(!responses.length)await Promise.resolve();const committed=responses.pop();if(committed?.body?.committed!==true)throw Error('missing_committed');
 const frames=localObjectFrames(clientStream,scope,id,()=>clientProof.verified),client=new LocalReadClient(scope,id,frames,nonce);
 return {server,client,frames,clientStream,serverStream,clientProof,serverProof,id,windowId:readWindowId,running,async close(){await frames.close();await running;clientProof.close();}};
}
