import {expect,test} from 'bun:test';
import {hex} from '@podjs/framework/crypto';
import {watchLocalProjection} from '../../src/sync-v2';
import {WatchCloudIndex} from '../../src/sync-v2/cloud-index';
import {SyncV2Http} from '../../src/sync-v2/http';
import {buildTree} from '../../src/sync-v2/merkle';
import {canonical,jsonBytes} from '../../src/sync-v2/protocol';
import {signCommit} from '../../src/sync-v2/signing';
import type {WatchProjectionStore} from '../../src/sync-v2/store';
import {b64} from '../../src/sync-v2/wire';
import {cipher,idKey,libraryId,productCipherHost,scope,SqlFixture} from './fixture';
import {crypto,publicBytes,serverPin,SyntheticIndexBackend} from './p2-fixture';

const tableInfo='PRAGMA table_info(syncv2_cloud_rows)';
const author='a'.repeat(32);

async function emptyIndex(store:WatchProjectionStore){
 const server=new SyntheticIndexBackend(),tree=buildTree(scope,[]);
 const commit=await signCommit(crypto,'key',{
  version:2,scope,authorDeviceId:author,deviceSequence:'1',previousOwnCommit:null,
  mergedParents:[],treeRoot:tree.oid,requiredFeatures:[],createdAtMillis:100,
  observedRefs:[],indexComplete:true,accountParent:null,rollbackGeneration:'0',
  operation:{kind:'normal',rollbackTarget:null,resolvesGeneration:null},
 });
 server.objects.set(tree.oid,tree.bytes);
 server.objects.set(commit.oid,jsonBytes({body:commit.body,signature:commit.signature}));
 const session=async()=>({accessToken:'synthetic',legacyDeviceId:'approved-old',userId:'00000000-0000-0000-0000-000000000001',scope});
 const http=new SyncV2Http(server,'http://localhost:3000',scope,session,true,serverPin());
 const reader=new WatchCloudIndex(store,http,crypto,{id:idKey,content:Buffer.alloc(32,0x22),version:1},
  async deviceId=>({deviceId,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),async()=>{},()=>100);
 expect(await reader.pull(server.window())).toEqual({empty:true});
 server.account.commitOid=commit.oid;
 server.account.revision='1';
 // A signed zero-row tree skips stageCloudRows entirely, then runs cleanup.
 expect(await reader.pull(server.window())).toEqual({empty:false,rows:0,awaitingUser:false,bodyReads:0});
 expect((await reader.pull(server.window())).checkpointHit).toBe(true);
 expect(await store.cloudRowCount(tree.oid)).toBe(0);
 expect(await store.cloudRows(tree.oid)).toEqual([]);
 expect(await store.cloudRow(tree.oid,'e'.repeat(64))).toBeNull();
}

test('cloud rows schema supports a new install with an empty account index',async()=>{
 const db=new SqlFixture();
 try{
  const store=db.store();
  await store.initialize();
  await emptyIndex(store);
  expect((await db.query(tableInfo)).map(row=>row.name)).toEqual(['scope','root','entity_key','body']);
 }finally{db.close();}
});

test('cloud rows schema repairs an initialized 1331 database with no staged rows',async()=>{
 const db=new SqlFixture();
 try{
  const previous=db.store();
  await previous.initialize();
  const saved=await previous.readState();
  // 1331 created this table only after staging its first cloud batch.
  db.raw.exec('DROP TABLE IF EXISTS syncv2_cloud_rows');
  expect(await db.query(tableInfo)).toEqual([]);
  const upgraded=db.store();
  await upgraded.initialize();
  expect(await upgraded.readState()).toEqual(saved);
  await emptyIndex(upgraded);
  expect(await db.query(tableInfo)).toHaveLength(4);
 }finally{db.close();}
});

test('cloud rows schema supports the first foreground projection without a worker',async()=>{
 const db=new SqlFixture(),secure=productCipherHost();
 try{
  const factory=watchLocalProjection({enabled:true,scope,libraryId,accountScope:'cloud-rows',descriptor:{},
   identity:{installed:async()=>({idKeyHex:hex(idKey)})},
   metadata:{cloudRestoreMetadata:async()=>({articles:[],next:undefined})},
   host:async<T>(method:string,args:Record<string,unknown>):Promise<T>=>{
    if(method==='sql.query')return await db.query(String(args.sql),args.params as unknown[]) as T;
    if(method==='sql.transaction')return await db.transaction(args.statements as Parameters<SqlFixture['transaction']>[0]) as T;
    return secure.host(method,args);
   },
  });
  const local=await factory.open();
  expect(local).not.toBeNull();
  await emptyIndex(local!.store);
  expect(await db.query(tableInfo)).toHaveLength(4);
 }finally{db.close();}
});

test('cloud rows schema preserves readable legacy ciphertext on each reopen',async()=>{
 const db=new SqlFixture();
 try{
  const root=buildTree(scope,[]).oid,entity='e'.repeat(64),value={fixture:'legacy row'};
  const aad=canonical({domain:'wrss.sync.v2/local-projection',version:2,scope,libraryId,purpose:'cloud-row',id:root+entity});
  const sealed=await cipher.seal(aad,value);
  db.raw.exec('CREATE TABLE syncv2_cloud_rows(scope TEXT NOT NULL,root TEXT NOT NULL,entity_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,root,entity_key))');
  db.raw.query('INSERT INTO syncv2_cloud_rows VALUES(?,?,?,?)').run(canonical(scope),root,entity,sealed);
  for(let attempt=0;attempt<2;attempt++){
   const reopened=db.store();
   await reopened.initialize();
   expect(await reopened.cloudRow(root,entity)).toEqual(value);
   expect(await reopened.cloudRows(root)).toEqual([value]);
   expect(await reopened.cloudRowCount(root)).toBe(1);
   expect(await db.query('SELECT body FROM syncv2_cloud_rows')).toEqual([{body:sealed}]);
  }
 }finally{db.close();}
});
