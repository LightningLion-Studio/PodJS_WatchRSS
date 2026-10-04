import {base64ToBytes,utf8ToString,stringToUtf8} from '@podjs/framework/bytes';
import type {HttpTransport} from '../cloud/types.ts';
import type {TtsConfig,TtsEngine} from './config-store.ts';
import {watchAppVersion} from '../core/app-version.ts';

export interface TtsAccount {backendBaseUrl:string;watchDeviceToken:string}
export interface TtsSynthesisOptions {config:TtsConfig;apiKey:string;account?:TtsAccount|null;text:string;rate:number;requestId:string}
const defaults:Record<TtsEngine,{model:string;voiceId:string;baseUrl:string}>={
 local:{model:'',voiceId:'',baseUrl:''},backend_default:{model:'',voiceId:'',baseUrl:''},
 minimax:{model:'speech-2.8-hd',voiceId:'male-qn-qingse',baseUrl:'https://api.minimaxi.com'},
 azure:{model:'zh-CN-XiaoxiaoNeural',voiceId:'zh-CN-XiaoxiaoNeural',baseUrl:''},
 doubao:{model:'zh_female_wanwanxin_moon_bigtts',voiceId:'zh_female_wanwanxin_moon_bigtts',baseUrl:'https://openspeech.bytedance.com'}
};
const hex=(value:string)=>{if(!value||value.length%2||!/^[0-9a-f]+$/i.test(value))throw new Error('响应缺少音频数据');const data=new Uint8Array(value.length/2);for(let i=0;i<data.length;i++)data[i]=parseInt(value.slice(i*2,i*2+2),16);return data;};
const audio64=(value:string)=>{if(!value)throw new Error('响应缺少音频数据');return base64ToBytes(value);};
const xml=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&apos;').replace(/"/g,'&quot;');
const responseJson=(body:Uint8Array)=>{try{return JSON.parse(utf8ToString(body));}catch{throw new Error('语音服务响应格式无效');}};
type ProviderError='backend'|'minimax'|'azure-token'|'azure-audio'|'doubao';
function httpFailure(body:Uint8Array,status:number,provider:ProviderError):string {
 const fallback=`HTTP ${status}`;
 if(provider==='azure-token')return `Azure token 请求失败：${fallback}`;
 const raw=utf8ToString(body).trim();
 if(provider==='backend'||provider==='minimax'){
  try{
   const parsed=JSON.parse(raw);
   const value=provider==='backend'?parsed?.error?.message:parsed?.base_resp?.status_msg||parsed?.message;
   return typeof value==='string'&&value.trim()?value.trim().slice(0,512):fallback;
  }catch{return fallback;}
 }
 return raw?raw.slice(0,512):fallback;
}
async function send(transport:HttpTransport,url:string,headers:Record<string,string>,body:string,provider:ProviderError){
 const response=await transport.request({method:'POST',url,headers,body:stringToUtf8(body)});
 if(response.status<200||response.status>=300)throw new Error(httpFailure(response.body,response.status,provider));
 return response.body;
}

export async function synthesizeCloudSpeech(transport:HttpTransport,options:TtsSynthesisOptions):Promise<Uint8Array>{
 const {config,text,rate,requestId}=options,engine=config.engine;
 if(engine==='local')throw new Error('本地语音不使用云端合成');
 if(!text.trim())throw new Error('朗读内容为空');
 if(!Number.isFinite(rate)||rate<0.5||rate>2)throw new Error('朗读语速无效');
 if(engine==='backend_default'){
  const account=options.account;if(!account?.watchDeviceToken||!account.backendBaseUrl)throw new Error('使用默认语音前请先登录');
  const url=account.backendBaseUrl.replace(/\/$/,'')+'/api/v1/tts/default-model/speech';
  const body=await send(transport,url,{Authorization:`Bearer ${account.watchDeviceToken}`,'Content-Type':'application/json','X-WatchRSS-App-Version':watchAppVersion},JSON.stringify({text,speed:1,format:'mp3'}),'backend');
  return hex(String(responseJson(body).audio??''));
 }
 const key=options.apiKey;if(!key)throw new Error('请先配置语音 API Key');
 const voice=config.voiceId||defaults[engine].voiceId,baseUrl=(config.baseUrl||defaults[engine].baseUrl).replace(/\/$/,'');
 if(engine==='minimax'){
  const body=await send(transport,baseUrl+'/v1/t2a_v2',{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},JSON.stringify({model:config.model||defaults.minimax.model,text,stream:false,voice_setting:{voice_id:voice,speed:rate,vol:1,pitch:0},audio_setting:{sample_rate:32000,bitrate:128000,format:'mp3',channel:1}}),'minimax');
  return hex(String(responseJson(body).data?.audio??''));
 }
 if(engine==='azure'){
  const tokenBody=await send(transport,'https://eastasia.api.cognitive.microsoft.com/sts/v1.0/issueToken',{'Ocp-Apim-Subscription-Key':key,'Content-Type':'application/x-www-form-urlencoded'},'','azure-token');
  const token=utf8ToString(tokenBody).trim();if(!token)throw new Error('Azure token 为空');
  const ssml=`<speak version='1.0' xml:lang='zh-CN'><voice xml:lang='zh-CN' name='${xml(voice)}'><prosody rate='${Math.round(rate*100)}%'>${xml(text)}</prosody></voice></speak>`;
  return send(transport,'https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1',{Authorization:`Bearer ${token}`,'Content-Type':'application/ssml+xml','X-Microsoft-OutputFormat':'audio-16khz-128kbitrate-mono-mp3'},ssml,'azure-audio');
 }
 const body=await send(transport,baseUrl+'/api/v1/tts',{Authorization:`Bearer; ${key}`,'Content-Type':'application/json'},JSON.stringify({app:{appid:'',token:'access_token',cluster:'volcano_tts'},user:{uid:'watchrss'},audio:{voice_type:voice,encoding:'mp3',speed_ratio:rate},request:{reqid:requestId,text,operation:'query'}}),'doubao');
 const data=responseJson(body).data;
 return audio64(typeof data==='string'?data:String(data?.audio??''));
}
