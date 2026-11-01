// Synthetic headless composition of the shipped previous-object restore path.
// Host adapters, codec, snapshot planner and secure checkpoint are production code.
import {WatchCloudCodec,type CloudObject} from '../../../src/cloud/codec';
import {createCloudHostPorts} from '../../../src/cloud/host-ports';
import {SnapshotRestoreCheckpoint} from '../../../src/cloud/snapshot-checkpoint';
import {restoreSnapshots} from '../../../src/cloud/snapshot-restore';
import {LegacySnapshotYieldBudget} from './stallguard-legacy';
import {SnapshotYieldBudget} from '../../../src/cloud/snapshot-deferral';
import {WorkWindow,windowedHost} from '@podjs/framework/work-window';
export default async function(context:any){
 const guard={require(){if(context.isCancelled())throw Error('cancelled');}};
 const window=new WorkWindow({deadlineMs:context.deadlineMs,reserveMillis:10000,expired:()=>Error('cloud_sync_deadline_exceeded')});
 const replay=context.payload.legacyGuard?new LegacySnapshotYieldBudget():new SnapshotYieldBudget();
 const request=async<T>(method:string,args:any):Promise<T>=>{(replay.before as any)(method,args);const result=await context.request(method,args);(replay.completed as any)(method,args);return result;};
 const host=windowedHost(request,window),ports=createCloudHostPorts(host,guard);
 const session:any=ports.foundation('user','fixture-watch',{request:async()=>{throw Error('no network');}},{baseUrl:'https://backend.invalid',accessToken:'public-fixture',appVersion:'fixture'});
 session.codec=new WatchCloudCodec(ports.crypto,guard,{writeV1:()=>true});
 session.userId='user';session.deviceId='fixture-watch';
 const {head,encrypted,key,bytes}=context.payload;
 session.keys={currentKeyVersion:async()=>1,accountKey:async()=>new Uint8Array(key)};
 session.state.applied=async()=>1;
 session.client.snapshot=async()=>({manifestUrl:'https://objects.invalid/manifest',chunks:[]});
 session.client.acknowledge=async()=>{};
 session.restoreCheckpoint={state:session.state,cache:session.cache,codec:session.codec,stalled:(value:boolean)=>replay.stalled(value)};
 const open=()=>new SnapshotRestoreCheckpoint(session,ports.crypto.sha256,async()=>{if(window.remainingMillis()<=0)throw Error('cloud_sync_deadline_exceeded');},Date.now).open('fixture-epoch','fixture-generation');
 let cp=await open();
 if(context.payload.seedStall){if(!cp.active)await cp.begin();await cp.noProgress(Error('cloud_sync_deadline_exceeded'));await cp.noProgress(Error('cloud_sync_deadline_exceeded'));cp.close();cp=await open();}
 try{
  if(!cp.active)await cp.begin();
  const restored:any=await restoreSnapshots({session,heads:[head],full:true,journal:cp,current:async()=>{},manifest:(_h,b)=>session.codec.decryptManifest(new Uint8Array(key),head.id,b),hash:ports.crypto.sha256,supported:()=>true,now:Date.now,status:()=>{},changed:()=>{}});
  const previous=restored.snapshots[0].manifest;
  if(context.payload.identicalRedo){
   const {contentSha256,...object}=previous.objects[0],chunk=object.chunks[0];
   Object.assign(object,{encoding:'identity',originalBytes:chunk.plaintextBytes,encodedBytes:chunk.plaintextBytes,chunks:[chunk]});
   // Deliberately redo one completed authenticated source without any receipt.
   for(let i=0;i<4;i++)await session.codec.restore(new Uint8Array(key),{...previous,objects:[object]},(hash:string)=>session.cache.rawChunk('user',hash));
   throw Error('identical redo escaped guard');
  }
  const snapshot=await session.codec.create({accountKey:new Uint8Array(key),keyVersion:1,sourceDeviceId:'fixture-watch',sequence:2,snapshotId:'fixture-next',createdAtMillis:2,parentHeads:{},observedHeads:{},previous,objects:[{name:'reader/fixture.txt',bytes:new Uint8Array(bytes),compress:false}],readPreviousChunk:(hash:string)=>session.cache.rawChunk('user',hash),readPreviousObject:(object:CloudObject)=>restored.readObject(previous,object)});
  if(snapshot.manifest.objects[0].chunks.length!==51)throw Error('source descriptors changed');
  await cp.finish();return {status:'success',work:cp.work};
 }catch(error){const code=String(error);if(code.includes('cloud_sync_deadline_exceeded')||code.includes('cloud_snapshot_work_timeout')){await cp.noProgress(error);return {status:'retry',work:cp.work,guardTimeout:code.includes('cloud_snapshot_work_timeout')};}throw error;}
 finally{cp.close();}
}
