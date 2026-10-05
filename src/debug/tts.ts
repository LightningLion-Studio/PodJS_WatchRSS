import {appLogger} from '../logs/app-logger.ts';
import type {DebugGate} from './gate.ts';
import {TtsConfigStore,type TtsEngine} from '../tts/config-store.ts';
import {synthesizeCloudSpeech,type TtsAccount} from '../tts/cloud-synth.ts';
import type {HttpTransport} from '../cloud/types.ts';
export const debugTtsEngines:Record<TtsEngine,string>={local:'本地 TTS',backend_default:'应用默认语音',minimax:'MiniMax',azure:'Azure',doubao:'豆包'};
const defaults={local:['','',''],backend_default:['','',''],minimax:['speech-2.8-hd','male-qn-qingse','https://api.minimaxi.com'],azure:['zh-CN-XiaoxiaoNeural','zh-CN-XiaoxiaoNeural',''],doubao:['zh_female_wanwanxin_moon_bigtts','zh_female_wanwanxin_moon_bigtts','https://openspeech.bytedance.com']};
export class DebugTts {
 constructor(private gate:DebugGate,private store:Pick<TtsConfigStore,"read"|"publicConfig"|"apiKey"|"selectDebugEngine">,private transport:HttpTransport,private account:()=>Promise<TtsAccount|null>){}
 async select(engine:TtsEngine){this.gate.require();try{if(engine==='backend_default'){const account=await this.account();if(!account?.backendBaseUrl||!account.watchDeviceToken)throw Error('使用默认语音前请先登录');}this.gate.require();const [model,voiceId,baseUrl]=defaults[engine];return this.store.selectDebugEngine(engine,{model,voiceId,baseUrl});}catch(error){if(engine==="backend_default")appLogger.e("TtsSettingsVM","Apply default voice failed");throw error;}}
 async status(){this.gate.require();const c=await this.store.publicConfig(),account=await this.account();return `${debugTtsEngines[c.engine]}\n模型 ${c.model||'默认'}\n音色 ${c.voiceId||'默认'}\nAPI Key ${c.apiKey?'已配置':'未配置'}\n账号 ${account?.watchDeviceToken?'已登录':'未登录'}`;}
 async test(){this.gate.require();const start=Date.now(),config=this.store.read();if(config.engine==='local')return '本地 TTS 已启用 · 延迟 0 ms';try{const bytes=await synthesizeCloudSpeech(this.transport,{config,apiKey:await this.store.apiKey(config.engine),account:await this.account(),text:'你好',rate:1,requestId:`debug-${start}`});return `连接成功 · 延迟 ${Date.now()-start} ms · ${bytes.length} bytes`;}catch(error){const messages={backend_default:"Backend default TTS test failed",minimax:"MiniMax TTS test failed",azure:"Azure TTS test failed",doubao:"Doubao TTS test failed"};appLogger.e("TtsSettingsVM",messages[config.engine]);throw error;}}
}
