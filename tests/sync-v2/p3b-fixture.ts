import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
import {ContentFiles} from '@podjs/framework/content-files';
import {WatchSpaceStore,type CachedBody} from '../../src/sync-v2/space-store';
import {WatchSpaceV2} from '../../src/sync-v2/space';
import {WatchRecovery} from '../../src/sync-v2/recovery';
import {canonical,digest} from '../../src/sync-v2/protocol';
import {signControl} from '../../src/sync-v2/signing';
import {captureChoice} from '../../src/sync-v2/state';
import {SqlFixture,cipher,scope,noteValue} from './fixture';
import {FileHost,crypt,pin} from './p3-fixture';
export const now=1000000000,id='e'.repeat(64),revision='f'.repeat(32),recipeOid='recipe:sha256:'+'8'.repeat(64),accountOid='commit:sha256:'+'7'.repeat(64),binding='6'.repeat(64);
export const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
export const item=(key=id)=>({entityKey:key,bodyRevision:revision,recipeOid,scope,kind:'rss',addedAtMillis:1,addedAtSource:'original' as const,lastOpenedAtMillis:null,localBytes:128,openedNow:false,dirty:false});
export const body=(key=id):CachedBody=>({item:item(key),metadata:{businessId:'stable '+key,addedAt:1,title:'synthetic title',isRead:true},status:'ready',plaintextSha256:sha(new Uint8Array(128).fill(33))});
const recoveryKey=Buffer.alloc(32,0x62);
export const recoveryCipher={
 async seal(aad:string,value:any){const n=randomBytes(12),c=createCipheriv('aes-256-gcm',recoveryKey,n);c.setAAD(Buffer.from(aad));return canonical({nonceBase64:n.toString('base64'),ciphertextBase64:Buffer.concat([c.update(canonical(value)),c.final(),c.getAuthTag()]).toString('base64')});},
 async open(aad:string,sealed:string){const v=JSON.parse(sealed),b=Buffer.from(v.ciphertextBase64,'base64'),d=createDecipheriv('aes-256-gcm',recoveryKey,Buffer.from(v.nonceBase64,'base64'));d.setAAD(Buffer.from(aad));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(0,-16)),d.final()]).toString());},
};
export async function fixture(existingRoot?:string){
 const root=existingRoot??mkdtempSync(join(tmpdir(),'wrss-p3b-')),db=new SqlFixture(join(root,'state.sqlite')),projection=db.store();await projection.initialize();const initial=await projection.readState();await projection.controlUpdate(initial,{...initial,account:{oid:accountOid,revision:'1',generation:'0'},lastSeenAccountOid:accountOid,lastSeenAccountRevision:'1'});
 const host=new FileHost(join(root,'files')),cache=new WatchSpaceStore(db,cipher,new ContentFiles(host.request),binding);await cache.init();let clock:number|null=now,capacity:number|null=0,mutation:((value:any)=>void)|undefined,beforeProof:(()=>Promise<void>)|undefined;const events:any[]=[],proof={accountOid,blobOids:[],recipeOid,entityKey:id,bodyRevision:revision,scope,keyVersion:1,authenticated:true};let requests=0;
 const servicePin=pin(),remote={http:{servicePin},crypto:crypt,async availability(expected:any){requests++;await beforeProof?.();const value={version:2,scope,entityKey:expected.entityKey,bodyRevision:expected.bodyRevision,recipeOid:expected.recipeOid,status:'cloud-ready',blobOidsHash:digest(expected.blobOids),storeId:'1'.repeat(32),receiptRevision:'1',createdAtMillis:now-1,expiresAtMillis:now+1000};mutation?.(value);return {status:value.status,receipt:await signControl(crypt,'synthetic','wrss.sync.v2/availability-sign',value)};}} as any;
 // Bootstrap belongs to setup, never to cleanup proof verification.
 await servicePin.assertBootstrap();
 const space=new WatchSpaceV2(cache,{projection,remote,localProof:async value=>({...proof,entityKey:value.item.entityKey}),capacity:async()=>capacity,trustedNow:()=>clock,event:e=>events.push(e)});
 async function add(value=body(),resourceId=digest(value.item.entityKey),bytes=new Uint8Array(128).fill(33)){const path=binding+'/'+resourceId+'.data';await cache.files.publish(path,bytes);await cache.register([{id:resourceId,path,bytes:bytes.length}]);await cache.add(value,[resourceId]);return {resourceId,path};}
 async function pending(){const before=await projection.readState();await projection.controlUpdate(before,{...before,pendingChoice:{generation:'0',inboxKeys:[]},hasUnsentEdits:true});return projection.readState();}
 const recovery=new WatchRecovery(projection,cache,{cipher:recoveryCipher,randomId:async()=>randomBytes(16).toString('hex'),trustedNow:()=>clock,source:async()=>[],reserve:async()=>async()=>{}});
 async function choice(local:any,cloud:any,extra:any={}){const state=await pending();return recovery.applyCloud({capture:captureChoice(state,state.account!),local,cloud,explicitCloudChoice:true,next:{...state,activeGeneration:'cloud',pendingChoice:null,hasUnsentEdits:false},statements:[],...extra});}
 return {root,db,projection,host,cache,space,recovery,proof,events,add,pending,choice,get requests(){return requests;},set clock(v:number|null){clock=v;},set capacity(v:number|null){capacity=v;},set mutation(v:((value:any)=>void)|undefined){mutation=v;},set beforeProof(v:(()=>Promise<void>)|undefined){beforeProof=v;},close(){db.close();rmSync(root,{recursive:true,force:true});}};
}
export const note=(title='local')=>({kind:'note' as const,value:{...noteValue('n'),title},bodyRefs:[]});
