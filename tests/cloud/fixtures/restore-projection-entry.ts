// Production checkpoint/host/book-file adapters. Synthetic immutable body and
// count-shaped metadata; no network, user files or alternate restore algorithm.
import {createCloudHostPorts} from '../../../src/cloud/host-ports';
import {SnapshotRestoreCheckpoint} from '../../../src/cloud/snapshot-checkpoint';
import {SnapshotYieldBudget} from '../../../src/cloud/snapshot-deferral';
import {createBookFiles} from '../../../src/books/files-port';
import {restoreRequestMetadata} from '../../../src/cloud/restore-callsite';
import {WorkWindow,windowedHost} from '@podjs/framework/work-window';
export default async function(context:any){
 const window=new WorkWindow({deadlineMs:context.deadlineMs,reserveMillis:10000,expired:()=>Error('cloud_sync_deadline_exceeded')});
 const budget=new SnapshotYieldBudget(),request=async<T>(method:string,args:Record<string,unknown>):Promise<T>=>{budget.before(method,args);const r=await context.request(method,args);budget.completed(method,args);return r;};
 const host=windowedHost(request,window),guard={require(){}},ports=createCloudHostPorts(host,guard),projection=createCloudHostPorts(host,guard,'projection');
 const session:any=ports.foundation('user','watch',{request:async()=>{throw Error('network prohibited');}},{baseUrl:'https://backend.invalid',accessToken:'public-fixture'});
 session.userId='user';session.deviceId='watch';session.keys={currentKeyVersion:async()=>1,accountKey:async()=>new Uint8Array(context.payload.key)};
 session.restoreCheckpoint={cache:new (session.cache.constructor)(projection.files,projection.crypto.sha256,guard,'https://backend.invalid'),state:session.state,codec:new (session.codec.constructor)(projection.crypto,guard),receipt:(id:number)=>{context.receipt(id);budget.stalled(false);},stalled:(v:boolean)=>budget.stalled(v)};
 const cp=await new SnapshotRestoreCheckpoint(session,ports.crypto.sha256,async()=>{if(window.remainingMillis()<=0)throw Error('cloud_sync_deadline_exceeded');},Date.now).open('current-epoch','current-generation');
 const root='a'.repeat(64),metadata=Array.from({length:30},(_,i)=>'b'.repeat(64)+'-meta'+i),aux=['c'.repeat(64),'d'.repeat(64)];
 try{
  if(context.payload.seed){await cp.begin();const children:string[]=[];for(let i=0;i<50;i++){const t=root+'-chunk-'+i;await cp.write(t,new Uint8Array(i<34?262144:196608).fill(i+1));children.push(t);}await cp.link(root,children,12058624);for(const t of metadata)await cp.write(t,new Uint8Array([1]));for(const t of aux)await cp.write(t,new Uint8Array(262145).fill(17));return {status:'seeded',work:cp.work};}
  // One runtime large decrypt: four staging writes + one native decrypt (#5).
  await ports.crypto.decrypt(new Uint8Array(context.payload.key),new Uint8Array(),new Uint8Array(context.payload.nonce),new Uint8Array(context.payload.ciphertext));
  for(const t of metadata)await cp.index(t);for(const t of aux)await cp.read(t);
  const body=await cp.range(root,0,12058624),checkpoint=cp.apply('current-package');
  // Same routing as createBackgroundLibrary: the baseline book writer was
  // outside metadata tagging; the candidate tags repository file operations.
  const m=restoreRequestMetadata('projection'),bookHost=checkpoint.scope?<T>(method:string,args:Record<string,unknown>)=>host<T>(method,m.args(method,args,['file.write','file.commit','file.compose'].includes(method)?13:undefined)):host;
  const file=await createBookFiles(bookHost,ports.crypto.sha256).writeBytes(body,checkpoint);
  await cp.commit('applied:fixture-book');return {status:'success',work:cp.work,path:file.path};
 }catch(error){if(/cloud_sync_deadline_exceeded|cloud_snapshot_work_timeout|cloud_snapshot_progress_stalled/.test(String(error))){session.restoreCheckpoint.state=createCloudHostPorts(request,guard).foundation('user','watch',{request:async()=>{throw Error('network prohibited');}},{baseUrl:'https://backend.invalid',accessToken:'public-fixture'}).state;return {status:'retry',work:cp.work,code:String(await cp.noProgress(error))};}throw error;}
 finally{cp.close();}
}
