/** Abrupt process exit inside the actual product SQLite apply transaction. */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {ContentFiles} from '@podjs/framework/content-files';
import {SqlFixture,cipher,scope,idKey} from './fixture';
import {FileHost} from './p3-fixture';
import {recoveryCipher} from './p3b-fixture';
import {WatchSpaceStore} from '../../src/sync-v2/space-store';
import {WatchRecovery} from '../../src/sync-v2/recovery';
import {WatchAccountControl} from '../../src/sync-v2/account-control';
import {WatchAccountBusinessSql} from '../../src/sync-v2/account-business';
import {fromWire} from '../../src/sync-v2/business';
const [root,mode,edge]=process.argv.slice(2),db=new SqlFixture(join(root!,'state.sqlite'),mode),store=db.store(),saved=JSON.parse(readFileSync(join(root!,'audit.json'),'utf8')),cache=new WatchSpaceStore(db,cipher,new ContentFiles(new FileHost(join(root!,'files')).request),'6'.repeat(64));
const business=new WatchAccountBusinessSql(db,store,scope,idKey,{recoveryValue:async id=>{const c=await store.readCandidate(id);return {kind:c.meta.kind,value:fromWire(c.meta.kind,c.meta.payload,c.state.payload),bodyRefs:[]};}},async()=>{},async()=>async()=>{}),recovery=new WatchRecovery(store,cache,{cipher:recoveryCipher,randomId:async()=>randomBytes(16).toString('hex'),trustedNow:()=>100,source:async()=>[],reserve:async()=>async()=>{}});
const transaction=db.transaction.bind(db);let first=true;
db.transaction=async statements=>{if(!first)return transaction(statements);first=false;if(edge==='count'){console.log(statements.length);return transaction(statements);}db.raw.exec('BEGIN IMMEDIATE');let at=0;for(const s of statements){if(Number(edge)===at++)process.exit(78);db.raw.query(s.sql).run(...(s.params??[]) as any[]);}if(Number(edge)===at++)process.exit(78);db.raw.exec('COMMIT');if(Number(edge)===at)process.exit(78);};
const control=new WatchAccountControl({store,business,recovery,choiceApply:true,historyRestore:false,trustedNow:()=>100,http:{choiceApply:true,requestResult:async(id:string)=>id===saved.requestId?{status:'succeeded',response:saved.response}:{status:'unknown',response:null},json:async()=>({accepted:true})} as any,reader:{} as any,publisher:{} as any,crypto:{} as any,approved:async()=>{throw Error('not_used');},author:async()=>({deviceId:'a'.repeat(32),alias:'unused',own:{commitOid:null,revision:'0'}})});
await control.resumeCloudChoice();db.close();
