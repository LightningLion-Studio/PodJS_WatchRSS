import {mount} from '@pocketjs/framework/solid';
import {View} from '@pocketjs/framework/components';
import {createSignal,Show} from 'solid-js';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {delay,fileChunks} from '@podjs/framework/services';
import {ShareQrScreen} from '../../../src/ui/ShareQrScreen.tsx';
import {systemShareRows} from '../../../src/ui/SettingsScreen.tsx';
import {SettingsStore} from '../../../src/settings/store.ts';
import {CHANNEL_SHARE_QR_HINT} from '../../../src/sharing/policy.ts';
import {supportsSystemShare} from '../../../src/sharing/host.ts';
const metrics=getDisplayMetrics(),store=new SettingsStore(),[settings,setSettings]=createSignal(store.load());
const key='system-share-ui-result',links=['https://example.com/article/123','https://例子.test/文章?标题=中文&emoji=⌚','https://example.com/'+ 'a'.repeat(450)];
const [stage,setStage]=createSignal<string|null>(null);let supported=false;
const fail=(error:unknown)=>kv.set(key,{state:'failed',error:String(error)});
const rows=(available:boolean)=>systemShareRows({width:metrics.logicalWidth,height:metrics.logicalHeight,state:settings(),systemShareSupported:available,onChange:patch=>setSettings(store.update(patch)),onNavigate:()=>{}},metrics.logicalWidth-36);
async function run(){
 supported=await supportsSystemShare();if(supported)throw Error('Expected API 30 native compatibility gate');if(rows(supported).length!==0)throw Error('Unsupported system share row visible');
 for(const name of ['qr-0','qr-1','qr-2','channel','system-off','system-on']){
  if(name==='system-on')setSettings(store.update({shareUseSystem:true}));setStage(name);await delay(2000).result;
  kv.set(key,{state:'running',stage:name,systemSupported:supported,settings:store.load(),metrics});
  const deadline=Date.now()+30000;while(!(await fileChunks.stat('share-advance-'+name)).file){if(Date.now()>deadline)throw Error('Stage timeout '+name);await delay(100).result;}
  setStage(null);await delay(150).result;
 }
 kv.set(key,{state:'passed',stage:'done',systemSupported:supported,unsupportedRowHidden:true});
}
function App(){return <Show when={stage()} keyed>{name=>name.startsWith('system-')?<View class="absolute left-[18] right-[18] top-[55]" style={{height:rows(true)[0].height}}>{rows(true)[0].render()}</View>:<ShareQrScreen width={metrics.logicalWidth} height={metrics.logicalHeight} title={name==='channel'?'测试频道':'测试分享'} url={name==='channel'?links[1]:links[Number(name.slice(3))]} topHint={name==='channel'?CHANNEL_SHARE_QR_HINT:undefined} onClose={()=>{}} onError={fail}/>}</Show>;}
mount(App);void run().catch(fail);
