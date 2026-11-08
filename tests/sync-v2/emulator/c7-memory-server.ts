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
import {SyntheticIndexBackend,crypto,publicBytes,serviceInfo} from '../p2-fixture';

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
class C7Backend extends SyntheticIndexBackend {
 override async request(r:any):Promise<any>{
  const path=decodeURIComponent(new URL(r.url).pathname.replace('/functions/v1/sync/v2',''));
  if(path==='/capabilities'){const res=await super.request(r),v=parseNetwork(res.body);v.features=['note-segments.v1'];return {...res,body:jsonBytes(v)};}
  if(path.startsWith('/state-refs/')&&r.method==='GET'&&!this.tables.has(path.slice(12)))return fail('object_missing',404);
  if(path.startsWith('/objects/')&&r.method==='GET'&&!path.includes('/parts/')&&!this.objects.has(path.slice(9)))return fail('object_missing',404);
  return super.request(r);
 }
}
let server=new C7Backend();
Bun.serve({port,hostname:'127.0.0.1',maxRequestBodySize:4*1024*1024,async fetch(req){
 const path=new URL(req.url).pathname;
 if(path==='/c7/reset'){server=new C7Backend();return Response.json({ok:true});}
 if(path==='/c7/window')return new Response(jsonBytes(server.window()) as BodyInit);
 if(path==='/c7/device')return new Response(jsonBytes({commitOid:server.device.commitOid,revision:server.device.revision}) as BodyInit);
 if(path==='/c7/stats')return Response.json({objects:server.objects.size,account:server.account});
 const headers:Record<string,string>={};req.headers.forEach((v,k)=>{headers[k==='content-type'?'Content-Type':k]=v;});
 const body=req.method==='GET'||req.method==='HEAD'?null:new Uint8Array(await req.arrayBuffer());
 try{const res=await server.request({method:req.method,url:req.url,headers,body:body&&body.length?body:null});return new Response(res.body as BodyInit,{status:res.status,headers:res.headers});}
 catch(error){console.error('synthetic route failed',path,(error as Error).message);return new Response(jsonBytes({error:{code:"synthetic_failure",retryable:false,retryAfterMillis:null,details:{}}}) as BodyInit,{status:500});}
}});
console.log('c7-memory-server ready',port);
