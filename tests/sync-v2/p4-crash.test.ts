import {test,expect} from 'bun:test';
import {writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {PeerCustodyStore} from '../../src/sync-v2/peer-custody';
import {signControl} from '../../src/sync-v2/signing';
import {digest} from '../../src/sync-v2/protocol';
import {b64} from '../../src/sync-v2/wire';
import {scope} from './fixture';
import {crypt,pub} from './p3-fixture';
import {cache,approved,watchId,phoneId,nonce} from './p4-fixture';
for(const phase of ['before','during','after'])test('custody real SIGKILL '+phase+' transaction retains one complete state',async()=>{
 const f=await cache(),body={version:2,scope,pinId:await nonce(),holderDeviceId:phoneId,claimantDeviceId:watchId,entityKey:'1'.repeat(64),bodyRevision:'2'.repeat(32),recipeOid:'recipe:sha256:'+'3'.repeat(64),blobOidsHash:digest([]),createdAtMillis:1},pin=await signControl(crypt,'fixture','wrss.sync.v2/custody-pin-sign',body);writeFileSync(join(f.root,'input.json'),JSON.stringify({pin,publicKey:b64(pub)}),{mode:0o600});const child=Bun.spawn(['bun',join(import.meta.dir,'p4-crash-child.ts'),f.root,phase],{stdout:'ignore',stderr:'ignore'});
 try{const end=Date.now()+10000;while(!existsSync(join(f.root,'ready'))&&Date.now()<end){if(child.exitCode!==null)throw Error('crash_child_exited');await new Promise(r=>setTimeout(r,10));}expect(existsSync(join(f.root,'ready'))).toBe(true);child.kill('SIGKILL');await child.exited;const custody=new PeerCustodyStore(f.store,scope,watchId,crypt,approved),expected={scope,entityKey:body.entityKey,bodyRevision:body.bodyRevision,recipeOid:body.recipeOid,blobOids:[]};if(phase==='after'){expect((await custody.authorize(expected)).receipt.body).toEqual(body);expect((await f.store.page('',32,'custody-for:')).length).toBe(1);}else{await expect(custody.authorize(expected)).rejects.toThrow('custody_missing');expect((await f.store.page('',32,'custody-id:')).length).toBe(0);expect((await f.store.page('',32,'custody-for:')).length).toBe(0);}}
 finally{if(child.exitCode===null){child.kill('SIGKILL');await child.exited;}await f.close();}
},15000);
