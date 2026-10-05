import {AcousticCodec,AcousticStreamDecoder,synthesizeChunk,type AcousticPacket,type Compression} from './codec.ts';
import {AcousticConnectionProtocol,linksOnly,type Ability,type AcousticMode,type GuidedWifiEnvelope,type TextCodec} from './protocol.ts';
export interface Operation<T>{result:Promise<T>;cancel():void}
export interface AcousticPorts {
 requireDebug():void;
 request<T>(method:string,args:Record<string,unknown>):Operation<T>;
 compression:Compression;
 text:TextCodec;
 fromBase64(value:string):Uint8Array;
 toBase64(bytes:Uint8Array):string;
 savedLinks(ability:'SYNC_FAVORITES'|'SYNC_WATCH_LATER'):Promise<string[]>;
 remoteInput(url:string):void;
}
export interface AcousticState {phase:'idle'|'preparing'|'ready'|'permission'|'listening'|'playing'|'connecting'|'exchanging'|'success'|'error'|'cancelled';message:string;detail?:string;durationMs?:number;busy:boolean;canStart:boolean}
export class AcousticConnectionSession {
 readonly protocol:AcousticConnectionProtocol;readonly codec:AcousticCodec;
 private generation=0;private operations=new Set<Operation<unknown>>();private pcm?:number;private wifi?:number;private prepared?:AcousticPacket;
 private mode:AcousticMode='SOUND_GUIDED_WIFI';private ability:Ability='REMOTE_INPUT';
 private value:AcousticState={phase:'idle',message:'选择声波连接方式',busy:false,canStart:true};
 constructor(private readonly ports:AcousticPorts,private readonly changed:(state:AcousticState)=>void=()=>{}){this.protocol=new AcousticConnectionProtocol(ports.text);this.codec=new AcousticCodec(ports.compression);}
 get state(){return this.value;}
 private publish(phase:AcousticState['phase'],message:string,extra:Partial<AcousticState>={}){this.value={phase,message,busy:['preparing','permission','listening','playing','connecting','exchanging'].includes(phase),canStart:phase==='ready'||phase==='error'||phase==='idle',...extra};this.changed(this.value);}
 private current(epoch:number){this.ports.requireDebug();if(epoch!==this.generation)throw Error('声波操作已取消');}
 private async call<T>(epoch:number,method:string,args:Record<string,unknown>):Promise<T>{this.current(epoch);const operation=this.ports.request<T>(method,args);this.operations.add(operation);try{const value=await operation.result;this.current(epoch);return value;}finally{this.operations.delete(operation);}}
 private async release(){const pcm=this.pcm,wifi=this.wifi;this.pcm=undefined;this.wifi=undefined;await Promise.all([pcm===undefined?undefined:this.ports.request('acoustic.pcm.stop',{session:pcm}).result.catch(()=>{}),wifi===undefined?undefined:this.ports.request('acoustic.wifi.close',{session:wifi}).result.catch(()=>{})]);}
 async cancel(){this.generation++;for(const operation of this.operations)operation.cancel();this.operations.clear();this.prepared=undefined;this.publish('cancelled','已停止', {canStart:true});await this.release();}
 async select(mode:AcousticMode,ability:Ability){this.ports.requireDebug();await this.cancel();this.mode=mode;this.ability=ability;const epoch=this.generation;
  if(ability==='SYNC_BILI_WATCH_RECORDS'||ability==='TTS_CONFIG'||ability==='LLM_SUMMARY_CONFIG'){this.publish('idle',ability==='LLM_SUMMARY_CONFIG'?'AI 摘要无需配置':ability==='TTS_CONFIG'?'朗读语音配置不支持声波连接':'B站观看记录不支持声波连接',{canStart:false});return;}
  if(mode==='PURE_SOUND'&&ability!=='REMOTE_INPUT'){
   this.publish('preparing','正在整理要发送的数据…');try{const links=await this.ports.savedLinks(ability);this.current(epoch);if(!links.length)throw Error(ability==='SYNC_FAVORITES'?'暂无收藏可同步':'暂无稍后再看可同步');const packet=await this.codec.encode(this.protocol.buildPureSoundSavedItems(ability,links));this.current(epoch);this.prepared=packet;this.publish('ready','请在手机上选择“纯声波 > 接收手表同步”',{durationMs:packet.durationMs});}catch(e){if(epoch===this.generation)this.publish('error',String(e));}
  }else this.publish('ready',mode==='PURE_SOUND'?'请在手机上选择“纯声波 > 发送 RSS 到手表”':'请在手机上选择对应的“声波引导 WiFi”操作');
 }
 async start(){this.ports.requireDebug();if(this.value.busy||!this.value.canStart)return;const epoch=this.generation;
  try{if(this.mode==='PURE_SOUND'&&this.ability!=='REMOTE_INPUT'){
    if(!this.prepared)throw Error('请重新选择要同步的操作');this.publish('playing','正在播放声波…');await this.play(epoch,this.prepared);this.publish('success','声波发送完成',{detail:'请到手机端查看接收结果'});
   }else{
    const guided=this.mode==='SOUND_GUIDED_WIFI';await this.permission(epoch,guided);
    this.publish('listening',guided?'正在听取手机连接信息…':'正在聆听手机发来的声波…');const bytes=await this.listen(epoch);
    if(guided)await this.guided(epoch,this.protocol.parseGuidedWifi(bytes));
    else {const e=this.protocol.parsePureSound(bytes);if(e.ability!=='REMOTE_INPUT')throw Error('当前声波内容不是 RSS 输入');if(!e.url)throw Error('声波中未包含 RSS 地址');this.current(epoch);this.publish('success','已收到 RSS 地址',{detail:e.url});this.ports.remoteInput(e.url);}
   }
  }catch(e){if(epoch===this.generation)this.publish('error',String(e));}finally{if(epoch===this.generation)await this.release();}
 }
 /** Same debug bypass as native EXTRA_DEBUG_GUIDED_PAYLOAD_BASE64. No token logging. */
 async debugGuidedPayload(bytes:Uint8Array){this.ports.requireDebug();if(this.value.busy)return;const epoch=this.generation;try{await this.guided(epoch,this.protocol.parseGuidedWifi(bytes));}catch(e){if(epoch===this.generation)this.publish('error',String(e));}finally{if(epoch===this.generation)await this.release();}}
 private async permission(epoch:number,guided:boolean){this.publish('permission','正在申请所需权限…');const state=await this.call<string>(epoch,'acoustic.requestPermission',{guided});if(state!=='granted')throw Error('未授予所需权限');}
 private async listen(epoch:number):Promise<Uint8Array>{
  const opened=await this.call<{session:number}>(epoch,'acoustic.pcm.open',{mode:'record'});this.pcm=opened.session;const decoder=new AcousticStreamDecoder();
  try{for(;;){const chunk=await this.call<{pcm16Base64:string}>(epoch,'acoustic.pcm.read',{session:opened.session}),bytes=this.ports.fromBase64(chunk.pcm16Base64);if(bytes.length%2||bytes.length>8192||!bytes.length)throw Error('无效 PCM 数据');const samples=new Int16Array(bytes.length/2);for(let i=0;i<samples.length;i++)samples[i]=(bytes[i*2]|bytes[i*2+1]<<8);const compressed=decoder.push(samples);if(compressed){const result=await this.codec.decompress(compressed);this.current(epoch);return result;}}}
  finally{if(this.pcm===opened.session)this.pcm=undefined;await this.ports.request('acoustic.pcm.stop',{session:opened.session}).result.catch(()=>{});}
 }
 private async play(epoch:number,packet:AcousticPacket){
  const opened=await this.call<{session:number}>(epoch,'acoustic.pcm.open',{mode:'play'});this.pcm=opened.session;
  for(let offset=0;offset<packet.sampleCount;){const chunk=synthesizeChunk(packet,offset),bytes=new Uint8Array(chunk.length*2);for(let i=0;i<chunk.length;i++){bytes[i*2]=chunk[i]&255;bytes[i*2+1]=(chunk[i]>>>8)&255;}
   const result=await this.call<{samples:number}>(epoch,'acoustic.pcm.write',{session:opened.session,pcm16Base64:this.ports.toBase64(bytes)});if(!Number.isInteger(result.samples)||result.samples<=0||result.samples>chunk.length)throw Error('声波播放失败');offset+=result.samples;
  }await this.call(epoch,'acoustic.pcm.drain',{session:opened.session});
 }
 private async guided(epoch:number,e:GuidedWifiEnvelope){
  if(this.ability!==e.ability)throw Error('手机端引导的能力与当前操作不一致');
  if(!['REMOTE_INPUT','SYNC_FAVORITES','SYNC_WATCH_LATER'].includes(e.ability))throw Error('不支持的声波同步能力');
  this.publish('connecting','已收到连接信息',{detail:e.passphrase.trim()?`正在连接手机热点 ${e.ssid}…`:'正在通过当前 WiFi 连接手机…'});
  const opened=await this.call<{session:number}>(epoch,'acoustic.wifi.connect',{ssid:e.ssid,passphrase:e.passphrase});this.wifi=opened.session;
  this.publish('exchanging','已连接手机',{detail:'正在通过 WiFi 与手机交换数据…'});await this.call(epoch,'runtime.delay',{milliseconds:450});
  if(e.ability==='REMOTE_INPUT'){
   const response=await this.call<Record<string,unknown>>(epoch,'acoustic.wifi.request',{session:opened.session,host:e.host,port:e.port,token:e.token,path:'pullRemoteInput'});this.success(response,'获取 RSS 失败');
   if(typeof response.url!=='string'||!response.url.trim())throw Error('手机端没有待发送的 RSS 地址');
   this.publish('exchanging','已从手机取得 RSS',{detail:'正在打开添加页面…'});await this.call(epoch,'runtime.delay',{milliseconds:450});this.current(epoch);this.publish('success','已从手机取得 RSS',{detail:response.url});this.ports.remoteInput(response.url);
  }else{
   const links=await this.ports.savedLinks(e.ability as 'SYNC_FAVORITES'|'SYNC_WATCH_LATER');this.current(epoch);if(!links.length)throw Error('暂无可同步数据');
   const response=await this.call<Record<string,unknown>>(epoch,'acoustic.wifi.request',{session:opened.session,host:e.host,port:e.port,token:e.token,path:e.ability==='SYNC_FAVORITES'?'pushFavorites':'pushWatchLater',body:JSON.stringify({items:linksOnly(links)})});this.success(response,'上传失败');this.publish('success','已同步至手机',{detail:'手机 companion 中已经可以看到最新数据'});
  }
 }
 private success(response:Record<string,unknown>,fallback:string){if(response.success===false||response.success==='false')throw Error(typeof response.message==='string'?response.message:fallback);}
}
