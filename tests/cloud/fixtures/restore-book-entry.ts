// Production book repository + file/checkpoint/host adapters. Synthetic host
// supplies SQLite, immutable files and an admission clock; never user data.
import {SqlBookStore} from '../../../src/books/store';
import {createBookFiles} from '../../../src/books/files-port';
import {createCloudHostPorts} from '../../../src/cloud/host-ports';
import {SnapshotRestoreCheckpoint} from '../../../src/cloud/snapshot-checkpoint';
import {SnapshotYieldBudget} from '../../../src/cloud/snapshot-deferral';
import {restoreRequestMetadata} from '../../../src/cloud/restore-callsite';
import {checkpointedFile,WorkWindow,windowedHost} from '@podjs/framework/work-window';
import {ImportedTextWriter,javaUtf8Chunks} from '../../../src/reader/imported-text-writer';
import {encodeUtf8} from '@podjs/framework/bytes';
import {observeCpuWork} from '@podjs/framework/cpu-work';
export default async function(context:any){
 const window=new WorkWindow({deadlineMs:context.deadlineMs,reserveMillis:10000,expired:()=>Error('cloud_sync_deadline_exceeded')});
 const budget=new SnapshotYieldBudget(),request=async<T>(method:string,args:Record<string,unknown>):Promise<T>=>{budget.before(method,args);const value=await context.request(method,args);budget.completed(method,args);return value;};
 const host=windowedHost(request,window),guard={require(){}},ports=createCloudHostPorts(host,guard),session:any=ports.foundation('fixture-user','fixture-watch',{request:async()=>{throw Error('network prohibited');}},{baseUrl:'https://backend.invalid',accessToken:'public-fixture'});
 session.userId='fixture-user';session.deviceId='fixture-watch';session.keys={currentKeyVersion:async()=>1,accountKey:async()=>new Uint8Array(32)};
 session.restoreCheckpoint={state:session.state,cache:session.cache,codec:session.codec,receipt:(id:number)=>{context.receipt(id);budget.stalled(false);},stalled:(v:boolean)=>budget.stalled(v)};
 const cp=await new SnapshotRestoreCheckpoint(session,ports.crypto.sha256,async()=>{if(window.remainingMillis()<=0)throw Error('cloud_sync_deadline_exceeded');},Date.now).open('current-epoch','current-generation');
 const stop=observeCpuWork((m:any)=>context.cpu(m));
 const m=restoreRequestMetadata('projection'),bookHost=<T>(method:string,args:Record<string,unknown>)=>host<T>(method,m.args(method,args,['file.write','file.commit','file.compose'].includes(method)?13:undefined));
 const files=createBookFiles(bookHost,ports.crypto.sha256),db={query:(sql:string,params:unknown[]=[])=>host<any[]>('sql.query',{sql,params}),execute:async(sql:string,params:unknown[]=[])=>{await host('sql.execute',{sql,params});},transaction:async(statements:any[])=>{await host('sql.transaction',{statements});},transactionChanges:(statements:any[])=>host<number[]>('sql.transaction',{statements,reportChanges:true})};
 const articleHost=<T>(method:string,args:Record<string,unknown>)=>host<T>(method,m.args(method,args,['file.write','file.commit','file.compose'].includes(method)?15:undefined));
 const writer=new ImportedTextWriter({resumable:async(id,text,checkpoint)=>{const keyHash=await ports.crypto.sha256(encodeUtf8(id)),parts=[...javaUtf8Chunks(text)],bytes=new Uint8Array(parts.reduce((n,b)=>n+b.length,0));let at=0;for(const b of parts){bytes.set(b,at);at+=b.length;}const file=await checkpointedFile(articleHost,bytes,{directory:'article_content',identity:'imported-text-v2:'+keyHash,hash:ports.crypto.sha256,checkpoint,target:(_binding,digest)=>'article_content/v2-'+keyHash+'-'+digest+'.txt'});return 'watchrss-watch-content:'+file.path.slice('article_content/'.length);},createTemp:()=>{throw Error('checkpoint required');},write:()=>{throw Error('checkpoint required');},append:()=>{throw Error('checkpoint required');},hash:()=>{throw Error('checkpoint required');},commit:()=>{throw Error('checkpoint required');},remove:async()=>{}});
 const store=new SqlBookStore(db,{files,sha256:ports.crypto.sha256,stableId:(url:string)=>ports.crypto.sha256(encodeUtf8(url)),deviceId:async()=>'fixture-watch',text:{hydrate:async(s:string)=>s,storeText:(id,text,checkpoint)=>writer.storeText(id,text,()=>false,checkpoint)},diagnostic:(d:any)=>context.diagnostic(d)});
 try{
  if(!cp.active)await cp.begin();
  for(const book of context.payload.installed){const unit='installed:'+book.id;if(cp.has(unit))continue;const at=Date.now();await store.installPackage(book.info,book.id,cp.apply(unit));context.stage('installed',Date.now()-at);await cp.commit(unit);}
  if(context.payload.fresh){const fresh=context.payload.fresh,unit='new:'+fresh.id;if(!cp.has(unit)){const checkpoint=cp.apply(unit),at=Date.now(),info=await files.writeBytes(new Uint8Array(fresh.bytes),checkpoint,fresh.id);context.stage('output',Date.now()-at);await store.installPackage(info,fresh.id,checkpoint);await cp.commit(unit);}}
  return {status:'success',work:cp.work};
 }catch(error){if(/cloud_sync_deadline_exceeded|cloud_snapshot_work_timeout|cloud_snapshot_progress_stalled/.test(String(error))){session.restoreCheckpoint.state=createCloudHostPorts(request,guard).foundation('fixture-user','fixture-watch',{request:async()=>{throw Error('network prohibited');}},{baseUrl:'https://backend.invalid',accessToken:'public-fixture'}).state;return {status:'retry',work:cp.work,code:String(await cp.noProgress(error))};}throw error;}
 finally{cp.close();stop();}
}
