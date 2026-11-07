import {test,expect} from 'bun:test';
import {localObjectAuthenticator} from '../../src/sync-v2/local-auth';
import {buildTree} from '../../src/sync-v2/merkle';
import {signControl} from '../../src/sync-v2/signing';
import {jsonBytes} from '../../src/sync-v2/protocol';
import {objectOid} from '../../src/sync-v2/sealed';
import {cache,openLocal,approved,phoneId} from './p4-fixture';
import {scope} from './fixture';
import {crypt,keys} from './p3-fixture';
const authenticate=localObjectAuthenticator({scope,crypto:crypt,keys,approved,refsAuthor:()=>approved(phoneId)});
test('local treeDiff reads authenticated canonical nodes and respects known subtrees',async()=>{
 const f=await cache(authenticate),tree=buildTree(scope,[]);await f.objects.adopt(tree.oid,tree.bytes.length,async(at,n)=>tree.bytes.slice(at,at+n));const s=await openLocal(f.objects);try{const body={scope,windowId:s.windowId,treeRoot:tree.oid,knownNodes:[],pageToken:null};expect(await s.client.control('syncObjectsV2.treeDiff',body)).toEqual({windowId:s.windowId,nodes:[tree.oid],pageToken:null});expect((await s.client.control('syncObjectsV2.treeDiff',{...body,knownNodes:[tree.oid]})).nodes).toEqual([]);await expect(s.client.control('syncObjectsV2.treeDiff',{...body,pageToken:'tampered'})).rejects.toThrow('invalid_schema');await expect(s.client.control('syncObjectsV2.stateRefsGet',{scope,windowId:s.windowId,parentOid:'recipe:sha256:'+'0'.repeat(64)})).rejects.toThrow('invalid_oid');}finally{await s.close();await f.close();}
});
test('raw local reference tables require approved signatures and exact child grammar',async()=>{
 const f=await cache(authenticate);try{const signed=await signControl(crypt,'fixture','wrss.sync.v2/recipe-refs-sign',{scope,recipeOid:'recipe:sha256:'+'1'.repeat(64),blobOids:[]}),raw=jsonBytes(signed),id=objectOid('recipe-refs',raw);await f.objects.adopt(id,raw.length,async(at,n)=>raw.slice(at,at+n));expect((await f.objects.status(id)).status).toBe('present');const forged=jsonBytes({...signed,body:{...signed.body,blobOids:['blob:sha256:'+'2'.repeat(64)]}});await expect(authenticate(objectOid('recipe-refs',forged),forged)).rejects.toThrow('signature_invalid');}finally{await f.close();}
});
