/** Loopback synthetic sync-v2 server for the C7 emulator memory probe. It holds
 * a fresh in-memory account per reset and a key pair generated per process; the
 * emulator signs with that same synthetic key. Usage:
 *   bun tests/sync-v2/emulator/c7-memory-server.ts <port> <fixture-output.json> */
import {generateKeyPairSync,sign} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {hex} from '@podjs/framework/crypto';
import {jsonBytes} from '../../../src/sync-v2/protocol';
import {b64} from '../../../src/sync-v2/wire';
import {parseNetwork} from '../../../src/sync-v2/http';
import {crypto,publicBytes,serviceInfo} from '../p2-fixture';
import {P5Backend} from '../p5-fixture';
import {randomBytes} from 'node:crypto';
import {scope,idKey,libraryId,binding,cipher,noteValue,SqlFixture} from '../fixture';
import {WatchProjectionStore} from '../../../src/sync-v2/store';
import {ProjectionGate} from '../../../src/sync-v2/gate';
import {WatchIndexPublisher} from '../../../src/sync-v2/publisher';
import {WatchCloudIndex} from '../../../src/sync-v2/cloud-index';
import {SyncV2Http} from '../../../src/sync-v2/http';

const port=Number(process.argv[2]),out=process.argv[3];
if(!(port>1024)||!out)throw Error('usage: c7-memory-server.ts <port> <fixture.json>');
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});
const low=(raw:Uint8Array)=>{const n=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'),s=BigInt('0x'+hex(raw.subarray(32)));return Buffer.concat([raw.subarray(0,32),Buffer.from((s>n/2n?n-s:s).toString(16).padStart(64,'0'),'hex')]);};
// One synthetic key for the device and the receipt signer, as in the Bun tests.
publicBytes.set(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]));
crypto.sign=async(_,input)=>low(sign('sha256',input,{key:pair.privateKey,dsaEncoding:'ieee-p1363'}));
serviceInfo.receiptSigningPublicKey=b64(new Uint8Array(pair.publicKey.export({format:'der',type:'spki'})));
writeFileSync(out,JSON.stringify({syntheticOnly:true,port,publicKeyBase64Url:Buffer.from(publicBytes).toString('base64url'),serviceInfo,privateKeyPkcs8Pem:pair.privateKey.export({format:'pem',type:'pkcs8'})}),{mode:0o600});

const fail=(code:string,status=409)=>({status,headers:{},body:jsonBytes({error:{code,retryable:false,retryAfterMillis:null,details:{}}})});
/** P5 endpoints (follow ACK, history, choices) plus the C7 capability. */
class C7Backend extends P5Backend {
 override async request(r:any):Promise<any>{
  const path=decodeURIComponent(new URL(r.url).pathname.replace('/functions/v1/sync/v2',''));
  if(path==='/capabilities'){const res=await super.request(r),v=parseNetwork(res.body);v.features=['note-segments.v1'];return {...res,body:jsonBytes(v)};}
  if(path.startsWith('/state-refs/')&&r.method==='GET'&&!this.tables.has(path.slice(12)))return fail('object_missing',404);
  if(path.startsWith('/objects/')&&r.method==='GET'&&!path.includes('/parts/')&&!this.objects.has(path.slice(9)))return fail('object_missing',404);
  return super.request(r);
 }
}
let server=new C7Backend();
/** A phone-side writer with a larger text budget adds note `big` (F1 input for
 * the watch: over its 2 MiB budget) on top of the current account. */
async function addOversize(chars:number){
 const db=new SqlFixture(),store=new WatchProjectionStore(db,cipher,new ProjectionGate(true),scope,libraryId,idKey,async()=>{},{noteSegments:true});await store.initialize();await store.beginScan(binding);
 const keys={id:idKey,content:new Uint8Array(32).fill(0x22),version:1},http=new SyncV2Http(server,'http://localhost:3000',scope,async()=>({accessToken:'synthetic',legacyDeviceId:'old',userId:'00000000-0000-0000-0000-000000000001',scope}),true,(await import('../p2-fixture')).serverPin());
 const budget=16*1024*1024,reader=new WatchCloudIndex(store,http,crypto,keys,async d=>({deviceId:d,keyId:'b'.repeat(32),publicKey:b64(publicBytes)}),async()=>{},()=>server.clock,undefined,{noteSegments:true,noteTextBudget:budget}),publisher=new WatchIndexPublisher(store,http,crypto,keys,()=>server.clock,undefined,{noteSegments:true,noteTextBudget:budget});
 try{if(server.account.commitOid){await reader.pull(server.window());const s=await store.readState();await store.controlUpdate(s,{...s,hasUnsentEdits:false,editBase:{accountOid:s.account!.oid,generation:s.account!.generation}});}
  const rows:any[]=[];let after='';const s=await store.readState();if(s.cloud?.current)for(;;){const page=await store.cloudRows(s.cloud.current.treeRoot,after,1);if(!page.length)break;rows.push({kind:page[0].meta.kind,logicalId:page[0].meta.logicalId,value:(await import('../../../src/sync-v2/business')).fromWire(page[0].meta.kind,page[0].meta.payload,page[0].state.payload),addedAtMillis:page[0].row.addedAtMillis});after=page[0].row.entityKey;}
  const t='大'.repeat(chars);rows.push({kind:'note',logicalId:'big',value:{...noteValue('big'),markdown:t,plainText:t,baseMarkdown:t},addedAtMillis:1});
  const cp=await store.checkpoint();if(cp&&cp.phase!=='scan')await store.restartScan();for(let i=0;i<rows.length;i++)await store.scanPage({page:async()=>({rows:[rows[i]],after:'r'+String(i).padStart(4,'0'),done:i===rows.length-1}),changed:async()=>[]});
  await publisher.prepare('a'.repeat(32),'key',{commitOid:server.device.commitOid,revision:server.device.revision},randomBytes(16).toString('hex'));await publisher.flush();return rows.length;
 }finally{db.close();}
}
Bun.serve({port,hostname:'127.0.0.1',maxRequestBodySize:4*1024*1024,async fetch(req){
 const path=new URL(req.url).pathname;
 if(path==='/c7/reset'){server=new C7Backend();return Response.json({ok:true});}
 if(path==='/c7/window')return new Response(jsonBytes(server.window()) as BodyInit);
 if(path==='/c7/device')return new Response(jsonBytes({commitOid:server.device.commitOid,revision:server.device.revision}) as BodyInit);
 if(path==='/c7/oversize')return Response.json({rows:await addOversize(Number(new URL(req.url).searchParams.get('chars')))});
 if(path==='/c7/stats')return Response.json({objects:server.objects.size,account:server.account});
 const headers:Record<string,string>={};req.headers.forEach((v,k)=>{headers[k==='content-type'?'Content-Type':k]=v;});
 const body=req.method==='GET'||req.method==='HEAD'?null:new Uint8Array(await req.arrayBuffer());
 try{const res=await server.request({method:req.method,url:req.url,headers,body:body&&body.length?body:null});return new Response(res.body as BodyInit,{status:res.status,headers:res.headers});}
 catch(error){console.error('synthetic route failed',path,(error as Error).message);return new Response(jsonBytes({error:{code:"synthetic_failure",retryable:false,retryAfterMillis:null,details:{}}}) as BodyInit,{status:500});}
}});
console.log('c7-memory-server ready',port);
