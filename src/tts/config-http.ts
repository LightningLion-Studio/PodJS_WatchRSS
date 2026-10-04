import {readRemoteHttpRequest,writeRemoteHttpResponse,type RemoteHttpRequest,type RemoteHttpResponse} from '../remote-input/http.ts';
import type {SyncByteStream} from '../sync/stream.ts';
import {ConfigPairingSession,CONFIG_PAIRING_AUTH_HEADER,CONFIG_PAIRING_NONCE_HEADER,CONFIG_PAIRING_PROTOCOL} from './config-pairing.ts';
import {TtsConfigStore} from './config-store.ts';
import {remoteInputLanding} from '../remote-input/landing.ts';

const json=(status:number,value:unknown):RemoteHttpResponse=>({status,type:'application/json; charset=utf-8',body:JSON.stringify(value)});
const authError=()=>json(401,{success:false,message:'配对认证失败，请重新扫描手表上的二维码'});
const ability={code:'b8f4d9e2-1c7a-4e5b-9a3f-6d2e8c1b5f74',name:'朗读语音配置',version:'0.0.2',requiresPairingAuth:true,pairingProtocol:CONFIG_PAIRING_PROTOCOL};

export async function routeTtsConfigHttp(request:RemoteHttpRequest,pairing:ConfigPairingSession,store:TtsConfigStore):Promise<RemoteHttpResponse>{
 const method=request.method??'GET',uri=request.target.split('?',1)[0];
 if(method==='GET'&&uri==='/')return {status:200,type:'text/html; charset=utf-8',body:remoteInputLanding};
 if(method==='GET'&&uri==='/health')return json(200,{status:'ok'});
 if(method==='GET'&&uri==='/getCurrentActivationAbility')return json(200,ability);
 if(method==='GET'&&uri==='/getAbilities')return json(200,{status:'ok',abilities:[ability]});
 if(!((method==='GET'&&uri==='/getTtsConfig')||(method==='POST'&&uri==='/setTtsConfig')))return {status:404,type:'text/plain',body:'Not Found'};
 const nonce=request.headers[CONFIG_PAIRING_NONCE_HEADER.toLowerCase()],proof=request.headers[CONFIG_PAIRING_AUTH_HEADER.toLowerCase()];
 if(!await pairing.authenticate(method,uri,nonce,request.body,proof))return authError();
 if(method==='GET'){
  try{return {status:200,type:'application/json; charset=utf-8',body:await pairing.encryptResponse(method,uri,JSON.stringify({success:true,data:await store.publicConfig()}))};}
  catch{return json(500,{success:false,data:null});}
 }
 if(!request.body||request.body.length>65536)return json(400,{success:false,message:'加密配置正文缺失或过大'});
 let value:unknown;
 try{value=JSON.parse(await pairing.decryptRequest(method,uri,request.body));}
 catch{return json(400,{success:false,message:'无法解密配置正文'});}
 try{await store.validate(value);}catch(error){return json(400,{success:false,message:String(error).replace(/^Error: /,'')});}
 if(!pairing.claimWrite())return authError();
 try{await store.save(value);}catch(error){return json(400,{success:false,message:String(error).replace(/^Error: /,'')});}
 return json(200,{success:true,message:'配置已保存'});
}

export async function serveTtsConfigHttp(stream:SyncByteStream,isActive:()=>boolean,pairing:ConfigPairingSession,store:TtsConfigStore,onSaved?:()=>void):Promise<void>{
 try{
  let response:RemoteHttpResponse;
  let saved=false;
  try{const request=await readRemoteHttpRequest(stream);response=await routeTtsConfigHttp(request,pairing,store);saved=request.method==='POST'&&request.target==='/setTtsConfig'&&response.status===200;}
  catch{response=json(400,{success:false,message:'请求正文无效或过大'});}
  await writeRemoteHttpResponse(stream,isActive,response);
  if(saved)onSaved?.();
 }finally{await stream.close();}
}
