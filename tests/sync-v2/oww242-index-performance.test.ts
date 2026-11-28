import {expect,spyOn,test} from 'bun:test';
import {businessAuditBinding,candidates} from '../../src/sync-v2/business';
import {WatchAccountControl} from '../../src/sync-v2/account-control';
import {WatchCloudIndex} from '../../src/sync-v2/cloud-index';
import {IndexObjectCache} from '../../src/sync-v2/index-object-cache';
import {buildTree} from '../../src/sync-v2/merkle';
import {canonical,jsonBytes,nextD64} from '../../src/sync-v2/protocol';
import {objectOid,sealV2} from '../../src/sync-v2/sealed';
import {signCommit,signedMessage} from '../../src/sync-v2/signing';
import {b64} from '../../src/sync-v2/wire';
import {binding,cipher,scope} from './fixture';
import {approved,keys,p5Fixture} from './p5-fixture';
import {crypto} from './p2-fixture';

const author='a'.repeat(32),fingerprint='f'.repeat(64);
const windowId='1'.repeat(32);
const routes=(calls:Record<string,number>,prefix:string)=>Object.entries(calls)
 .filter(([route])=>route.startsWith(prefix)).reduce((sum,[,n])=>sum+n,0);

test('legacy authenticated head without signing fingerprint revalidates without object traffic',async()=>{
 const f=await p5Fixture();
 try{
  await f.publish();
  const before=await f.projection.readState();
  expect(before.cloud.current.signingFingerprint).toBeUndefined();
  let verified=0;
  const verifying={...crypto,async verify(...args:Parameters<typeof crypto.verify>){verified++;return crypto.verify(...args);}};
  const reader=new WatchCloudIndex(f.projection,f.http,verifying,keys,approved,async()=>{},()=>100);
  f.server.calls={};
  const result=await reader.pull(f.server.window(),false,fingerprint);
  expect(result.checkpointHit).toBe(true);
  expect(verified).toBe(1);
  expect(routes(f.server.calls,'/objects/')).toBe(0);
  expect(routes(f.server.calls,'/state-refs/')).toBe(0);
  expect((await f.projection.readState()).cloud.current.signingFingerprint).toBe(fingerprint);
  const changedSigner=new WatchCloudIndex(f.projection,f.http,crypto,keys,async id=>({...await approved(id),keyId:'0'.repeat(32)}),async()=>{},()=>100);
  await expect(changedSigner.pull(f.server.window(),false,'a'.repeat(64))).rejects.toThrow('signature_invalid');
 }finally{f.close();}
},30_000);

test('a failed batch keeps verified siblings on disk and caps fallback GET concurrency',async()=>{
 const f=await p5Fixture();
 try{
  const entries=Array.from({length:10},(_,i)=>{
   const raw=jsonBytes({i});
   return [objectOid('state',raw),raw] as const;
  });
  for(const [id,raw] of entries)f.server.objects.set(id,raw);
  const ids=entries.map(([id])=>id),failed=ids[3]!;
  let running=0,peak=0,fail=true;
  f.http.batch=async(_window,oids)=>({version:2,scope,objects:[],nextOids:oids});
  const original=f.http.object.bind(f.http);
  f.http.object=async(id,...rest)=>{
   running++;peak=Math.max(peak,running);
   try{await Bun.sleep(2);if(fail&&id===failed)throw Error('test_interrupted');return await original(id,...rest);}
   finally{running--;}
  };
  const read=()=>new IndexObjectCache(f.projection.indexObjects())
   .batch(ids,(wanted,save)=>f.http.objects(windowId,wanted,save,4));
  await expect(read()).rejects.toThrow('test_interrupted');
  expect(peak).toBe(4);
  fail=false;f.server.calls={};
  expect((await read()).size).toBe(ids.length);
  expect(routes(f.server.calls,'/objects/')).toBe(7);
  f.server.calls={};
  expect((await read()).size).toBe(ids.length);
  expect(routes(f.server.calls,'/objects/')).toBe(0);
 }finally{f.close();}
});

test('one remote change in 5,400 authenticated rows applies without reopening unchanged rows',async()=>{
 const f=await p5Fixture();
 try{
  const initial=await f.projection.readState(),auditBinding=businessAuditBinding(scope,keys.version,[]);
  const progress={stage(name:string){stage=name;},plan(){},advance(){}};
  let stage='',cloudOpens=0,candidateOpens=0,writeSql=0,writeOpens=0,writeSeals=0;
  const first={folderId:'folder-0',name:'before',sortOrder:0,updatedAt:1,modifiedBy:'watch',deleted:false,deletedAt:0};
  const native=Array.from({length:5400},(_,i)=>({...first,folderId:'folder-'+i,sortOrder:i}));
  const candidatesFor=(v:typeof first)=>candidates('folder',v.folderId,f.projection.entityKeyFor('folder',v.folderId),v);
  const decoded=native.map(v=>{
   const c=candidatesFor(v);
   return {meta:c.meta,state:c.state,row:{
    entityKey:c.meta.entityKey,metaOid:'meta:sha256:'+'a'.repeat(64),stateOid:'state:sha256:'+'b'.repeat(64),
    addedAtMillis:0,rowSequence:'1',deleted:false,requiredFeatures:[],bodyRevision:null,promiseId:null,recipeOid:null,opaqueContentId:null,contentBytes:null,
   },placeholder:'no-body',placeholderText:null};
  });
  const root=buildTree(scope,decoded.map(d=>d.row));
  const oldCommit=await signCommit(crypto,'key',{version:2,scope,authorDeviceId:author,deviceSequence:'1',previousOwnCommit:null,
   mergedParents:[],treeRoot:root.oid,requiredFeatures:[],createdAtMillis:100,observedRefs:[],indexComplete:true,accountParent:null,
   rollbackGeneration:'0',operation:{kind:'normal',rollbackTarget:null,resolvesGeneration:null}});
  const remember=(commit:typeof oldCommit)=>f.server.objects.set(commit.oid,jsonBytes({body:commit.body,signature:commit.signature}));
  remember(oldCommit);
  f.server.account={commitOid:oldCommit.oid,revision:'1',rollbackGeneration:'0'};
  const account={oid:oldCommit.oid,revision:'1',generation:'0'};
  const staged=await f.projection.stageCloudRows(root.oid,decoded,initial,false,[],true);
  // Seed the earlier approved account and native basis. Only the new row's
  // objects are present on the server. Reopening any old one is a regression.
  const insert=f.db.raw.query('INSERT INTO memo_folders VALUES(?,?,?,?,?,0,0)');
  f.db.raw.transaction(()=>{for(const n of native)insert.run(n.folderId,n.name,n.sortOrder,n.updatedAt,n.modifiedBy);})();
  await f.db.execute("DELETE FROM memo_notes");
  const before=await f.projection.readState();
  expect(before.stateVersion).not.toBe(staged.stateVersion);
  await f.projection.controlUpdate(before,{...before,account,lastSeenAccountOid:oldCommit.oid,lastSeenAccountRevision:'1',hasUnsentEdits:false,
   activeGeneration:oldCommit.oid,editBase:{accountOid:oldCommit.oid,generation:'0'},cloud:{
    auditBinding,cursor:f.server.serverRevision,pins:{accountOid:oldCommit.oid,authors:{[author]:{...await approved(author),sequence:'1',oid:oldCommit.oid}},seenOids:[]},
    current:{commitOid:oldCommit.oid,treeRoot:root.oid,rowCount:decoded.length},
   }});
  // The scan witness must match the native business revision before apply.
  const source={page:async()=>({rows:[],after:'',done:true}),changed:async()=>[]};
  await f.projection.beginScan(binding);
  while((await f.projection.checkpoint())?.phase!=='complete'){
   if((await f.projection.checkpoint())?.phase==='scan')await f.projection.scanPage(source);
   else await f.projection.catchUpPage(source);
  }
  const captured=await f.projection.readState();
  await f.projection.controlUpdate(captured,{...captured,hasUnsentEdits:false});
  await f.projection.stageHeaders([oldCommit],await f.projection.readState());
  const latest=candidatesFor({...first,name:'from phone',updatedAt:2});
  const meta=await sealV2(crypto,keys.id,keys.content,scope,'meta',keys.version,jsonBytes(latest.meta));
  const state=await sealV2(crypto,keys.id,keys.content,scope,'state',keys.version,jsonBytes(latest.state));
  f.server.objects.set(meta.oid,meta.bytes);f.server.objects.set(state.oid,state.bytes);
  const refsBody={scope,stateOid:state.oid,segmentOids:[]};
  await f.http.json('POST','/state-refs',{body:refsBody,signature:b64(await crypto.sign('key',signedMessage('wrss.sync.v2/state-refs-sign',refsBody)))});
  const tree=buildTree(scope,[{...decoded[0]!.row,metaOid:meta.oid,stateOid:state.oid,rowSequence:'2'},...decoded.slice(1).map(d=>d.row)]);
  for(const [id,raw] of tree.nodes)f.server.objects.set(id,raw);
  const current=await signCommit(crypto,'key',{...oldCommit.body,deviceSequence:'2',previousOwnCommit:oldCommit.oid,accountParent:oldCommit.oid,treeRoot:tree.oid});
  remember(current);f.server.account={...f.server.account,commitOid:current.oid,revision:'2'};f.server.serverRevision=nextD64(f.server.serverRevision);
  const reader=new WatchCloudIndex(f.projection,f.http,crypto,keys,approved,async()=>{},()=>100,undefined,{progress:()=>progress as any,readConcurrency:6,indexObjects:new IndexObjectCache()});
  const accountControl=new WatchAccountControl({store:f.projection,http:f.http,reader,publisher:f.publisher,crypto,approved,business:f.native,recovery:f.recovery,
   author:async()=>({deviceId:author,alias:'key',own:{commitOid:current.oid,revision:'2'}}),trustedNow:()=>100,choiceApply:true,progress:()=>progress as any});
  const cloudRow=f.projection.cloudRow.bind(f.projection);
  f.projection.cloudRow=async(...args)=>{cloudOpens++;return cloudRow(...args);};
  const candidate=f.projection.readCandidate.bind(f.projection);
  f.projection.readCandidate=async(...args)=>{if(stage==='write')candidateOpens++;return candidate(...args);};
  const query=f.db.query.bind(f.db),transaction=f.db.transaction.bind(f.db);
  f.db.query=async(...args)=>{if(stage==='write')writeSql++;return query(...args);};
  f.db.transaction=async(...args)=>{if(stage==='write')writeSql++;return transaction(...args);};
  f.server.calls={};f.db.sql=[];
  const open=cipher.open.bind(cipher),seal=cipher.seal.bind(cipher);
  const opening=spyOn(cipher,'open').mockImplementation(async(...args)=>{if(stage==='write')writeOpens++;return open(...args);});
  const sealing=spyOn(cipher,'seal').mockImplementation(async(...args)=>{if(stage==='write')writeSeals++;return seal(...args);});
  try{expect(await accountControl.follow(f.server.window(),fingerprint)).toEqual({applied:true});}
  finally{opening.mockRestore();sealing.mockRestore();}
  console.log('OWW242_DELTA',JSON.stringify({rows:decoded.length,cloudOpens,candidateOpens,writeSql,writeOpens,writeSeals,refs:routes(f.server.calls,'/state-refs/')}));
  expect(cloudOpens).toBe(1);
  expect(candidateOpens).toBe(1);
  expect(writeSql).toBeLessThan(100);
  expect(writeOpens).toBeLessThan(30);
  expect(writeSeals).toBeLessThan(15);
  expect(routes(f.server.calls,'/state-refs/')).toBe(1);
  expect(f.db.sql.filter(sql=>sql.startsWith('INSERT OR IGNORE INTO podjs_sql_cache_values'))).toHaveLength(1);
  expect((await f.db.query('SELECT name FROM memo_folders WHERE folder_id=?',[first.folderId]))[0]?.name).toBe('from phone');
  expect(await f.projection.cloudRowCount(tree.oid)).toBe(native.length);
  expect((await f.projection.readState()).activeGeneration).toBe(current.oid);
 }finally{f.close();}
},120_000);

test('observing a dirty account does not decrypt the local-only candidate inventory',async()=>{
 const f=await p5Fixture();
 try{
  await f.publish();
  const before=await f.projection.readState(),old=f.server.objects.get(before.account!.oid)!;
  const head=await signCommit(crypto,'key',{...JSON.parse(new TextDecoder().decode(old)).body,
   deviceSequence:'2',previousOwnCommit:before.account!.oid,accountParent:before.account!.oid});
  f.server.objects.set(head.oid,jsonBytes({body:head.body,signature:head.signature}));
  f.server.account={...f.server.account,commitOid:head.oid,revision:'2'};
  f.server.serverRevision=nextD64(f.server.serverRevision);
  // The ciphertext of a local-only row must remain opaque to observation.
  // It is owned by the subsequent publication/choice path.
  f.db.raw.query(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<5399)
   INSERT INTO syncv2_candidates SELECT ?,printf('%064x',i),'opaque candidate',0,0,0,'1' FROM seq`).run(canonical(scope));
  await f.projection.controlUpdate(before,{...before,hasUnsentEdits:true});
  let candidateOpens=0;
  const open=cipher.open.bind(cipher);
  const opening=spyOn(cipher,'open').mockImplementation(async(aad,body)=>{
   if(JSON.parse(aad).purpose==='candidate')candidateOpens++;
   return open(aad,body);
  });
  try{await f.reader.pull(f.server.window(),false,fingerprint);}
  finally{opening.mockRestore();}
  const after=await f.projection.readState();
  expect(candidateOpens).toBe(1);
  expect(after.hasUnsentEdits).toBe(true);
  expect(after.cloud.editCreates).toHaveLength(5399);
  expect(Number((await f.db.query('SELECT COUNT(*) AS n FROM syncv2_candidates'))[0]?.n)).toBe(5400);
 }finally{f.close();}
},30_000);
