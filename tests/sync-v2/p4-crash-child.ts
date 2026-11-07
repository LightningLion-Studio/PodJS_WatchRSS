/** SIGKILL fixture; private signing keys are never sent to the child. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ContentFiles} from '@podjs/framework/content-files';
import {WatchContentStore} from '../../src/sync-v2/content-store';
import {PeerCustodyStore} from '../../src/sync-v2/peer-custody';
import {SqlFixture,cipher,scope} from './fixture';
import {FileHost,crypt} from './p3-fixture';
import {proofs,watchId} from './p4-fixture';
const [root,phase]=process.argv.slice(2),input=JSON.parse(readFileSync(join(root,'input.json'),'utf8')),db=new SqlFixture(join(root,'state.sqlite')),files=new ContentFiles(new FileHost(join(root,'files')).request),store=new WatchContentStore(db,cipher,files,{scope,fixture:'p4'});await store.init();const [session]=await proofs(),custody=new PeerCustodyStore(store,scope,watchId,crypt,async deviceId=>({deviceId,keyId:'e'.repeat(32),publicKey:input.publicKey}));
const hold=async()=>{writeFileSync(join(root,'ready'),phase);setInterval(()=>{},1000);await new Promise(()=>{});};
if(phase==='before')await hold();
if(phase==='during'){const transaction=db.transaction.bind(db);db.transaction=async statements=>{if(statements.some(s=>s.params?.some(p=>typeof p==='string'&&p.startsWith('custody-id:')))){
 db.raw.exec('BEGIN IMMEDIATE');const first=statements[0]!;db.raw.query(first.sql).run(...(first.params??[]) as any[]);await hold();
 }else await transaction(statements);};}
await custody.accept(input.pin,session);await hold();
