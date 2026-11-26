import {expect,test} from 'bun:test';
import {openApplicationSyncV2} from '../../src/sync-v2/application-open';
import {parseCanonicalJson,jsonBytes} from '../../src/sync-v2/protocol';
import {fixture,scope,f as identity} from './p6-fix-fixture';
import {MemoRepository} from '../../src/notes/repository';
import {readTree} from '../../src/sync-v2/merkle';
import {openV2} from '../../src/sync-v2/sealed';
import {fromWire} from '../../src/sync-v2/business';
import {unhex} from '@podjs/framework/crypto';
import {crypto} from './p2-fixture';

type Fixture=Awaited<ReturnType<typeof fixture>>;
type Faults={dropPart?:boolean;loseRegistration?:boolean;losePublish?:boolean;checkSigningList?:boolean;failLookup?:boolean};
function transportFor(f:Fixture,faults:Faults={}){
 let listCurrent=true;
 const registrations:string[]=[],events:string[]=[];
 const transport={async request(request:Parameters<typeof f.server.request>[0]){
  const path=decodeURIComponent(new URL(request.url).pathname).replace('/functions/v1/sync/v2','');
  events.push(path.startsWith('/requests/')?'result':path);
  if(faults.failLookup&&path.startsWith('/requests/'))throw Error('synthetic_lookup_unavailable');
  if(faults.dropPart&&request.method==='PUT'){
   faults.dropPart=false;
   throw Error('synthetic_part_not_delivered');
  }
  if(faults.checkSigningList&&path==='/objects/have-want'&&!listCurrent)throw Error('signing_list_expired');
  const result=await f.server.request(request);
  if(path==='/devices/signing-key'){
   registrations.push(Buffer.from(request.body).toString('base64'));
   listCurrent=false;
   if(faults.loseRegistration){faults.loseRegistration=false;throw Error('synthetic_registration_reply_lost');}
  }
  if(path==='/devices/signing-keys')listCurrent=true;
  if(path==='/account/publish'&&faults.losePublish){faults.losePublish=false;throw Error('synthetic_publish_reply_lost');}
  if(path==='/state-refs'){
   const body=parseCanonicalJson(request.body).body;
   return {...result,body:jsonBytes({version:2,scope,...f.server.tables.get(body.stateOid),accepted:true})};
  }
  if(request.method==='PUT'){
   const oid=path.split('/')[2],raw=f.server.partials.get(oid);
   if(raw&&raw.length===f.server.totals.get(oid))f.server.objects.set(oid,raw);
  }
  return result;
 }};
 return {transport,faults,registrations,events};
}

async function save(f:Fixture,title:string,at:number){
 const memo=new MemoRepository(f.db,f.options.legacyDeviceId,undefined,()=>at);
 const original=await memo.get('n');
 await memo.save({noteId:'n',title,markdown:original!.markdown});
}

async function publishedTitles(f:Fixture){
 const raw=(id:string)=>f.server.objects.get(id)!;
 const {body}=parseCanonicalJson(raw(f.server.account.commitOid!));
 const rows=await readTree(scope,body.treeRoot,async id=>raw(id));
 const key=await f.options.keys.accountKey(),id=unhex(identity.idKeyHex);
 return Promise.all(rows.map(async row=>{
  const meta=(await openV2(crypto,id,key,scope,row.metaOid,raw(row.metaOid))).value;
  const state=(await openV2(crypto,id,key,scope,row.stateOid,raw(row.stateOid))).value;
  return (fromWire(meta.kind,meta.payload,state.payload) as {title:string}).title;
 }));
}

for(const [count,loseReply] of [[1,false],[2,false],[2,true]] as const){
 test(`first signing registration refreshes the publish window and author list (${count} notes, lost reply ${loseReply})`,async()=>{
  const f=await fixture(),io=transportFor(f,{dropPart:false,loseRegistration:loseReply,losePublish:false,checkSigningList:true});
  const open=()=>openApplicationSyncV2({...f.options,transport:io.transport});
  try{
   if(count===2)await f.db.execute(`INSERT INTO memo_notes SELECT '00000000-0000-0000-0000-000000000099',folder_id,'second note',markdown,plain_text,content_hash,base_content_hash,base_markdown,pinned,created_at,updated_at,modified_by,deleted,deleted_at FROM memo_notes`);
   if(loseReply)await expect(open()).rejects.toThrow('synthetic_registration_reply_lost');
   const opened=await open();
   try{
    expect(opened?.initialResult).toEqual({completionError:null});
    expect(f.server.events).toBe(1);
    expect(io.registrations).toHaveLength(loseReply?2:1);
    expect(new Set(io.registrations).size).toBe(1);
    const registered=io.events.lastIndexOf('/devices/signing-key');
    const upload=io.events.indexOf('/objects/have-want',registered);
    expect(io.events.slice(registered+1,upload).filter(path=>path==='/negotiate'||path==='/devices/signing-keys')).toEqual(['/negotiate','/devices/signing-keys','/negotiate']);
   }finally{await opened?.close();}
  }finally{f.db.close();}
 });
}

test('a save during the startup applied ACK is published in the first round',async()=>{
 const f=await fixture(),io=transportFor(f);
 const open=()=>openApplicationSyncV2({...f.options,transport:io.transport});
 try{
  const old=await open();await old?.close();
  f.server.onApplied=async()=>{
   f.server.onApplied=undefined;
   await save(f,'edit during startup ACK',300);
  };
  const opened=await open();
  try{
   expect(opened?.initialResult).toEqual({completionError:null});
   expect(f.server.events).toBe(2);
   expect(await publishedTitles(f)).toEqual(['edit during startup ACK']);
   expect(await f.db.query('SELECT title FROM memo_notes')).toEqual([{title:'edit during startup ACK'}]);
  }finally{await opened?.close();}
 }finally{f.db.close();}
});

for(const accepted of [false,true]){
 test(`a newer save supersedes interrupted publication (old request accepted: ${accepted})`,async()=>{
  const f=await fixture(),io=transportFor(f);
  const open=()=>openApplicationSyncV2({...f.options,transport:io.transport});
  let opened=await open();
  try{
   await save(f,'interrupted edit',200);
   io.faults.dropPart=!accepted;io.faults.losePublish=accepted;
   await expect(opened!.sync()).rejects.toThrow(accepted?'synthetic_publish_reply_lost':'synthetic_part_not_delivered');
   await save(f,'new save after failure',300);
   await opened?.close();opened=null;
   io.faults.failLookup=true;
   await expect(open()).rejects.toThrow('synthetic_lookup_unavailable');
   io.faults.failLookup=false;
   io.events.length=0;
   opened=await open();
   expect(opened?.initialResult).toEqual({completionError:null});
   expect(io.events.indexOf('result')).toBeGreaterThanOrEqual(0);
   expect(io.events.indexOf('result')).toBeLessThan(io.events.indexOf('/account/publish'));
   expect(f.server.publishedBodies).toHaveLength(accepted?3:2);
   expect(f.server.events).toBe(accepted?3:2);
   expect(await publishedTitles(f)).toEqual(['new save after failure']);
   expect(await f.db.query('SELECT title FROM memo_notes')).toEqual([{title:'new save after failure'}]);
   const reopened=await opened!.sync();
   expect(reopened).toEqual({completionError:null});
   expect(f.server.events).toBe(accepted?3:2);
  }finally{await opened?.close();f.db.close();}
 });
}
