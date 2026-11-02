// Production restore coordinator, codec and durable projection adapters.
import {createCloudHostPorts} from '../../../src/cloud/host-ports';
import {SnapshotRestoreCheckpoint} from '../../../src/cloud/snapshot-checkpoint';
import {restoreSnapshots} from '../../../src/cloud/snapshot-restore';
import {SnapshotYieldBudget} from '../../../src/cloud/snapshot-deferral';
import {utf8Encode} from '../../../src/cloud/types';
import {cpuJsonStringify} from '@podjs/framework/cpu-work';
import {WorkWindow,windowedHost} from '@podjs/framework/work-window';
export default async function(context:any){
 const window=new WorkWindow({deadlineMs:context.deadlineMs,reserveMillis:10000,expired:()=>Error('cloud_sync_deadline_exceeded')});
 const budget=new SnapshotYieldBudget(),request=async<T>(method:string,args:Record<string,unknown>):Promise<T>=>{budget.before(method,args);const r=await context.request(method,args);budget.completed(method,args);return r;};
 const ports=createCloudHostPorts(windowedHost(request,window),{require(){}}),projection=createCloudHostPorts(windowedHost(request,window),{require(){}},'projection');
 const session:any=ports.foundation('user','watch',{request:async()=>{throw Error('network prohibited');}},{baseUrl:'https://backend.invalid',accessToken:'public-fixture'});
 session.userId='user';session.deviceId='watch';session.keys={currentKeyVersion:async()=>1,accountKey:async()=>new Uint8Array(context.payload.key)};
 session.restoreCheckpoint={state:session.state,cache:new (session.cache.constructor)(projection.files,projection.crypto.sha256,{require(){}},'https://backend.invalid'),codec:new (session.codec.constructor)(projection.crypto,{require(){}}),receipt:(id:number)=>{context.receipt(id);budget.stalled(false);},stalled:(v:boolean)=>budget.stalled(v)};
 const current=async()=>{if(window.remainingMillis()<=0)throw Error('cloud_sync_deadline_exceeded');};
 const cp=await new SnapshotRestoreCheckpoint(session,ports.crypto.sha256,current,Date.now).open('current-epoch','current-generation');
 try{
  const manifest=context.payload.manifest,object=manifest.objects[0];
  const token=await ports.crypto.sha256(utf8Encode(cpuJsonStringify(['restore-object-v1',manifest.keyVersion,object])));
  if(context.payload.seed){await cp.begin();for(let i=0;i<context.payload.seedParts;i++)await cp.write(token+'-chunk-'+i,new Uint8Array(context.payload.partBytes).fill(i%251+1));return {status:'seeded',work:cp.work};}
  const restored=await restoreSnapshots({session,heads:[],full:true,journal:cp,current,manifest:async()=>{throw Error('unused');},hash:ports.crypto.sha256,supported:()=>true,now:Date.now,status:()=>{},changed:()=>{}});
  const bytes=await restored.readObject(manifest,object);
  await cp.commit('applied:fixture');return {status:'success',work:cp.work,sha256:await ports.crypto.sha256(bytes),bytes:bytes.length};
 }catch(error){if(/cloud_sync_deadline_exceeded|cloud_snapshot_work_timeout|cloud_snapshot_progress_stalled/.test(String(error))){session.restoreCheckpoint.state=createCloudHostPorts(request,{require(){}}).foundation('user','watch',{request:async()=>{throw Error('network prohibited');}},{baseUrl:'https://backend.invalid',accessToken:'public-fixture'}).state;return {status:'retry',work:cp.work,code:String(await cp.noProgress(error))};}throw error;}
 finally{cp.close();}
}
