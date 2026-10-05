import {appLogger} from '../logs/app-logger.ts';
import {utf8Encode,utf8Decode,type HttpTransport} from "../cloud/types.ts";
import type {WatchAccountState} from "../account/types.ts";
import {watchAppVersion} from '../core/app-version.ts';

export const SUMMARY_PRESETS=["简洁摘要","关键要点","深度解读","一句话总结"] as const;
export type SummaryStatus="idle"|"waiting"|"generating"|"done"|"error";
export interface SummaryState {status:SummaryStatus;text:string;error?:string;inputTokens?:number;outputTokens?:number;totalTokens?:number}
export interface SummarySource {title:string;content:string;contentHash?:string;plainText?:boolean}
export interface SummaryDependencies {
 source:(waiting:()=>void)=>Promise<SummarySource>;
 account:()=>Promise<WatchAccountState|null>;
 freshAccount:(account:WatchAccountState,force:boolean)=>Promise<WatchAccountState>;
 transport:HttpTransport;
 recordUsage:(model:string,usage:unknown)=>Promise<void>;
 cancel?:()=>void;
}
/** Native summary preview: bounded scan, whitespace collapse and HTML entity handling. */
export function summarySourceText(source:string,plainText=false):string {
 const html=!plainText&&source.slice(0,4096).includes("<");
 const limit=Math.min(source.length,64000);let out="",pending=false,inTag=false;
 const append=(ch:string)=>{if(/\s/u.test(ch)){if(out)pending=true;}else{if(pending&&out&&out.length<3000)out+=" ";out+=ch;pending=false;}};
 for(let index=0;index<limit&&out.length<3000;index++){
  const ch=source[index];
  if(html&&inTag){if(ch===">"){inTag=false;if(out)pending=true;}continue;}
  if(html&&ch==="<"){inTag=true;if(out)pending=true;continue;}
  if(html&&ch==="&"){
   let end=-1;for(let i=index+1;i<Math.min(limit,index+13);i++){if(source[i]===";"){end=i;break;}if(/[\s<&]/u.test(source[i]))break;}
   if(end>index){const entity=source.slice(index+1,end).toLowerCase();const named:Record<string,string>={nbsp:" ",amp:"&",lt:"<",gt:">",quot:'"',apos:"'"};let decoded=named[entity];
    if(!decoded&&/^#(?:x[0-9a-f]+|[0-9]+)$/i.test(entity)){const value=parseInt(entity.slice(entity[1]==="x"?2:1),entity[1]==="x"?16:10);if(value<=2147483647)decoded=String.fromCharCode(value);}
    if(decoded!==undefined)append(decoded);else if(out)pending=true;index=end;continue;
   }
  }
  append(ch);
 }
 return out;
}
const positive=(v:unknown)=>{const n=typeof v==="number"?v:Number(v);return Number.isFinite(n)&&n>0?Math.trunc(n):undefined;};
/** Keep the native summary failure reason visible in the card until the user retries. */
export function summaryDisplayText(state:SummaryState):string {
 if(state.status==="error")return `生成失败\n${state.error?.trim()||"未知错误"}\n点击重试`;
 return state.text||(state.status==="waiting"?"正在等待原文加载...":state.status==="generating"?"正在生成总结...":"正在准备总结...");
}
/** Native only shows this request's usage when enabled and a total was returned. */
export function summaryTokenUsageText(state:SummaryState,show:boolean):string|null {
 if(!show||state.status!=="done"||state.totalTokens===undefined)return null;
 const parts:string[]=[];
 if(state.inputTokens!==undefined)parts.push(`输入 ${state.inputTokens}`);
 if(state.outputTokens!==undefined)parts.push(`输出 ${state.outputTokens}`);
 parts.push(`合计 ${state.totalTokens}`);
 return parts.join(" · ");
}
/** One reader owns one session: folding preserves results; retry cannot overlap a live request. */
export class SummarySession {
 state:SummaryState={status:"idle",text:""};
 private alive=true;
 private running:Promise<void>|undefined;
 constructor(private deps:SummaryDependencies,private preset:()=>number,private changed:(state:SummaryState)=>void){}
 private publish(state:SummaryState){if(this.alive){this.state=state;this.changed(state);}}
 start():Promise<void>{
  if(!this.alive||this.state.status==="done")return Promise.resolve();
  if(this.running)return this.running;
  this.running=this.generate().finally(()=>{this.running=undefined;});return this.running;
 }
 dispose(){this.alive=false;this.deps.cancel?.();}
 private async generate(){
  try{
   this.publish({status:"idle",text:""});
   const source=await this.deps.source(()=>this.publish({status:"waiting",text:""}));if(!this.alive)return;
   this.publish({status:"generating",text:""});
   const account=await this.deps.account();if(!this.alive)return;
   if(!account)throw new Error("请先从已授权手机同步账号");
   if(!account.backendBaseUrl.trim())throw new Error("账号后端地址未配置");
   let current=await this.deps.freshAccount(account,false);if(!this.alive)return;
   const selected=this.preset(),body={title:source.title,content:summarySourceText(source.content,source.plainText),...(/^[0-9a-f]{64}$/.test(source.contentHash??"")?{contentHash:source.contentHash}:{}),promptPreset:Number.isInteger(selected)&&selected>=1&&selected<=4?selected:1,stream:false};
   const request=(value:WatchAccountState)=>this.deps.transport.request({method:"POST",url:value.backendBaseUrl.replace(/\/+$/,"")+"/api/v1/llm/default-model/article-summary",headers:{"Authorization":`Bearer ${value.watchDeviceToken}`,"Content-Type":"application/json","X-WatchRSS-App-Version":watchAppVersion},body:utf8Encode(JSON.stringify(body))});
   let response=await request(current);if(!this.alive)return;
   if(response.status===401||response.status===403){current=await this.deps.freshAccount(current,true);if(!this.alive)return;response=await request(current);if(!this.alive)return;}
   const raw=utf8Decode(response.body);let data:any;
   if(response.status<200||response.status>=300){try{data=JSON.parse(raw);}catch{data={};}throw new Error(response.status===402?"AI 总结仅限已购买 6 元授权的用户":response.status===401||response.status===403?"账号授权已失效，请从手机重新同步":String(data.detail||data.error||`HTTP ${response.status}`));}
   data=JSON.parse(raw);if(!data||typeof data!=="object"||Array.isArray(data))throw new Error("总结响应格式错误");
   await this.deps.recordUsage(typeof data.model==="string"&&data.model.trim()?data.model:"server-managed",data.usage).catch(()=>{});if(!this.alive)return;
   this.publish({status:"done",text:typeof data.text==="string"&&data.text.trim()?data.text:"（无内容）",inputTokens:positive(data.usage?.inputTokens),outputTokens:positive(data.usage?.outputTokens),totalTokens:positive(data.usage?.totalTokens)});
  }catch(error){if(this.alive)appLogger.e("LlmSummaryVM","Summary generation failed");this.publish({status:"error",text:"",error:error instanceof Error?error.message:String(error)});}
 }
}
