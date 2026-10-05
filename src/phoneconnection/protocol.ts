/** Native PhoneConnectionAbility / AcousticConnectionProtocol wire contract. */
export const abilities = {
 REMOTE_INPUT: { wireCode:'dc40517c-a09c-419c-8c4d-d3883258992e', displayName:'RSS订阅输入', acousticCode:'r' },
 SYNC_FAVORITES: { wireCode:'c4bf141f-b0de-46f7-a661-0a3ad0716bce', displayName:'收藏夹', acousticCode:'f' },
 SYNC_WATCH_LATER: { wireCode:'f1aa43bd-0fe3-4771-ae6b-d4799ecf84b5', displayName:'稍后阅读', acousticCode:'w' },
 SYNC_BILI_WATCH_RECORDS: { wireCode:'9a88f4ec-a071-4cf4-8b25-e735836ebb0d', displayName:'B站观看历史/进度', acousticCode:'b' },
 LLM_SUMMARY_CONFIG: { wireCode:'a3e72c1d-5f84-4b90-9d16-e8c047f2b3a1', displayName:'LLM总结配置', acousticCode:'l' },
 TTS_CONFIG: { wireCode:'b8f4d9e2-1c7a-4e5b-9a3f-6d2e8c1b5f74', displayName:'朗读语音配置', acousticCode:'t' },
} as const;
export type Ability = keyof typeof abilities;
export type AcousticMode = 'PURE_SOUND'|'SOUND_GUIDED_WIFI';
export interface GuidedWifiEnvelope { ability:Ability; ssid:string; passphrase:string; host:string; port:number; token:string }
export interface PureSoundEnvelope { ability:Ability; url?:string; items?:unknown[] }
export interface TextCodec { encode(text:string):Uint8Array; decode(bytes:Uint8Array):string }
export function abilityFromPayload(value:string):Ability {
 const normalized=value.trim();
 for(const [key,v] of Object.entries(abilities))if([key,v.wireCode,v.displayName,v.acousticCode].includes(normalized))return key as Ability;
 throw Error(`未知能力标识：${value}`);
}
export function linksOnly(links:readonly string[]):{link:string}[]{return links.map(link=>link.trim()).filter(Boolean).map(link=>({link}));}
export class AcousticConnectionProtocol {
 constructor(private readonly text:TextCodec){}
 private json(bytes:Uint8Array):Record<string,unknown>{const j=JSON.parse(this.text.decode(bytes));if(!j||typeof j!=='object'||Array.isArray(j))throw Error('声波数据格式无效');return j;}
 buildPureSoundRemoteInput(url:string){return this.text.encode(JSON.stringify({kind:'pure_sound',ability:'REMOTE_INPUT',url}));}
 buildPureSoundSavedItems(ability:Ability,links:readonly string[]){return this.text.encode(JSON.stringify({kind:'pure_sound',ability,items:linksOnly(links)}));}
 parsePureSound(bytes:Uint8Array):PureSoundEnvelope {
  const j=this.json(bytes);if(j.kind!=='pure_sound')throw Error('不是纯声波数据');
  if(typeof j.ability!=='string'||!Object.hasOwn(abilities,j.ability))throw Error('未知能力标识');
  return {ability:j.ability as Ability,...(typeof j.url==='string'&&j.url.trim()?{url:j.url}:{}),...(Array.isArray(j.items)?{items:j.items}:{})};
 }
 buildGuidedWifi(e:GuidedWifiEnvelope){return this.text.encode(JSON.stringify({k:'g',a:abilities[e.ability].acousticCode,...(e.ssid.trim()?{s:e.ssid}:{}),...(e.passphrase.trim()?{p:e.passphrase}:{}),h:e.host,o:e.port,t:e.token}));}
 parseGuidedWifi(bytes:Uint8Array):GuidedWifiEnvelope {
  const j=this.json(bytes),str=(a:string,b:string,required=false)=>{const v=typeof j[a]==='string'&&(j[a] as string).trim()?j[a]:j[b];if(required&&typeof v!=='string')throw Error(`声波缺少 ${b}`);return typeof v==='string'?v:'';};
  if(!['g','guided_wifi'].includes(str('k','kind')))throw Error('不是声波引导 WiFi 数据');
  const port=Number(Object.hasOwn(j,'o')?j.o:j.port);if(!Number.isInteger(port))throw Error('无效端口');
  return {ability:abilityFromPayload(str('a','ability',true)),ssid:str('s','ssid'),passphrase:str('p','passphrase'),host:str('h','host',true),port,token:str('t','token',true)};
 }
}
