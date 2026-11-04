import {mount} from '@pocketjs/framework/solid';
import {View,Text} from '@pocketjs/framework/components';
import {Show,createSignal,onMount} from 'solid-js';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {hostOperation} from '@podjs/framework/services';
import {NotesListScreen} from '../../src/ui/NotesScreen';
import {MemoRepository} from '../../src/notes/repository';
import {createBackgroundLibrary} from '../../src/cloud/background-library';
import {createCloudHostPorts} from '../../src/cloud/host-ports';
import {createCloudTransport} from '../../src/cloud/transport';
import {WatchCloudLibraryAdapter} from '../../src/cloud/library';
import {WatchCloudSyncService,type CloudSession} from '../../src/cloud/service';
import type {SqlDatabase} from '../../src/core/types';
const guard={require(){}},metrics=getDisplayMetrics();
const host=<T,>(method:string,args:Record<string,unknown>)=>hostOperation<T>(method,args).result;
const db:SqlDatabase={query:(sql,params=[])=>host('sql.query',{sql,params}),execute:async(sql,params=[])=>{await host('sql.execute',{sql,params});},transaction:async statements=>{await host('sql.transaction',{statements});}};
const repository=new MemoRepository(db,'watch');
mount(()=>{
 const [ready,setReady]=createSignal(false),[status,setStatus]=createSignal('RESTORE'),[refresh,setRefresh]=createSignal(0);
 onMount(()=>{void(async()=>{
  const ports=createCloudHostPorts(host,guard),repo=await createBackgroundLibrary(host,async()=>undefined,guard);
  const transport=createCloudTransport(<T,>(method:string,args:Record<string,unknown>)=>{
   if(method==='http.download'){
    const url=String(args.url),prefix=url.startsWith('https://objects.invalid/')?'/objects/':url.startsWith('https://backend.invalid/')?'/':null;
    if(prefix===null)throw Error('fixture external network rejected');
    return host<T>(method,{...args,url:'http://127.0.0.1:18788'+prefix+url.split('/').slice(3).join('/')});
   }return host<T>(method,args);
  },guard);
  const foundation=ports.foundation('user','watch',transport,{baseUrl:'https://backend.invalid',accessToken:'fixture-token'});
  const library=new WatchCloudLibraryAdapter(repo,'watch',{...ports.crypto,stableId:ports.crypto.sha256 as any},guard);
  const session:CloudSession={...foundation,userId:'user',deviceId:'watch',displayName:'NOTESIMPORT synthetic account',library,keys:{publicKeySpki:async()=>'fixture-spki',currentKeyVersion:async()=>1,acceptBootstrap:async()=>'ready',accountKey:async()=>new Uint8Array(32).fill(41)},records:async()=>({pull:async()=>0,reapply:async()=>0,flush:async()=>0}) as any,assertCurrent:async()=>{}};
  const service=new WatchCloudSyncService({open:async()=>session,network:async()=>({active:true,validated:true,wifi:true,metered:false}),hash:ports.crypto.sha256,uuid:async()=> 'fixture-watch',exclusive:fn=>fn(),onChanged:()=>{setRefresh(n=>n+1);}},guard);
  service.subscribe(()=>{setStatus(service.status.phase);console.info('NotesImportStatus',JSON.stringify(service.status));});
  const result=await service.syncNow(true,'all');await repository.initialize();const notes=await repository.list();console.info('NotesImportProof',JSON.stringify({result,status:service.status,notes:notes.map(n=>({id:n.noteId,title:n.title,pinned:n.pinned})),all:(await repository.allIncludingDeleted()).length}));setStatus(result?'RESTORED':'ERROR '+service.status.message);setReady(result);setRefresh(n=>n+1);
 })().catch(error=>{setStatus(String(error));console.error('NotesImportError',String(error));});});
 return <View class="absolute inset-0 bg-black"><Show when={ready()}><NotesListScreen width={metrics.logicalWidth} height={metrics.logicalHeight} repository={repository} refreshKey={refresh()} onOpenNote={()=>{}} onOpenActions={()=>{}} onCreateNote={()=>{}} onError={setStatus}/></Show><View class="absolute left-[45] right-[45] bottom-[3] bg-black"><Text class="text-[10px] text-[#55ff88]">{status()}</Text></View></View>;
});
