// Frozen production call-path reproduction: newly carried entryRef validation
// and pending predecessor reads. No alternate codec or restore implementation.
import {WatchCloudCodec} from '../../../src/cloud/codec';
import {createCloudHostPorts} from '../../../src/cloud/host-ports';
import {SnapshotRestoreCheckpoint} from '../../../src/cloud/snapshot-checkpoint';
import {restoreSnapshots} from '../../../src/cloud/snapshot-restore';
import {SnapshotYieldBudget} from '../../../src/cloud/snapshot-deferral';
import {WorkWindow,windowedHost} from '@podjs/framework/work-window';
export default async function(context:any){
 const window=new WorkWindow({deadlineMs:context.deadlineMs,reserveMillis:10000,expired:()=>Error('cloud_sync_deadline_exceeded')});
 const budget=new SnapshotYieldBudget(),request=async<T>(method:string,args:Record<string,unknown>):Promise<T>=>{budget.before(method,args);const value=await context.request(method,args);budget.completed(method,args);return value;};
 const guard={require(){if(context.isCancelled())throw Error('cancelled');}},ports=createCloudHostPorts(windowedHost(request,window),guard);
 const session:any=ports.foundation('user','fixture-watch',{request:async()=>{throw Error('network prohibited');}},{baseUrl:'https://backend.invalid',accessToken:'public-fixture',appVersion:'fixture'});
 session.codec=new WatchCloudCodec(ports.crypto,guard,{writeV1:()=>true});session.userId='user';session.deviceId='fixture-watch';
 const key=new Uint8Array(context.payload.key);
 session.keys={currentKeyVersion:async()=>1,accountKey:async()=>key.slice()};
 session.restoreCheckpoint={state:session.state,cache:session.cache,codec:session.codec,stalled:(v:boolean)=>budget.stalled(v),receipt:(id:number)=>context.receipt?.(id)};
 const cp=await new SnapshotRestoreCheckpoint(session,ports.crypto.sha256,async()=>{if(window.remainingMillis()<=0)throw Error('cloud_sync_deadline_exceeded');},Date.now).open('fixture-epoch','fixture-generation');
 try{
  if(!cp.active)await cp.begin();
  const restored=await restoreSnapshots({session,heads:[],full:true,journal:cp,current:async()=>{if(window.remainingMillis()<=0)throw Error('cloud_sync_deadline_exceeded');},manifest:async()=>{throw Error('unused');},hash:ports.crypto.sha256,supported:()=>true,now:Date.now,status:()=>{},changed:()=>{}});
  // This authenticated pending manifest is deliberately absent from snapshots.
  const previous=await session.codec.decryptManifest(key,'fixture-prior',new Uint8Array(context.payload.encrypted));
  const ref=context.payload.ref;
  const snapshot=await session.codec.create({accountKey:key,keyVersion:1,sourceDeviceId:'fixture-watch',sequence:2,snapshotId:'fixture-next-'+context.payload.window,createdAtMillis:2,parentHeads:{},observedHeads:{},previous,
   objects:context.payload.mode==='pending'?[{name:'private-library.wrss',bytes:new Uint8Array(context.payload.logicalArchive),compress:false}]:[],
   carried:context.payload.mode==='pending'?[]:[ref],
   readPreviousChunk:(hash:string)=>session.cache.rawChunk('user',hash),
   readRestoreObject:(manifest:any,object:any,site:any)=>restored.readObject(manifest,object,site),restoreInflate:restored.inflateArchive,
  });
  if(context.payload.mode!=='pending'&&!snapshot.manifest.objects.some((o:any)=>o.entryRef))throw Error('entryRef not verified');
  await cp.finish();return {status:'success',work:cp.work};
 }catch(error){const code=String(error);if(/cloud_sync_deadline_exceeded|cloud_snapshot_work_timeout|cloud_snapshot_progress_stalled/.test(code)){const mapped=await cp.noProgress(error);return {status:'retry',work:cp.work,code:String(mapped)};}throw error;}
 finally{cp.close();key.fill(0);}
}
