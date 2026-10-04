import {mount} from '@pocketjs/framework/solid';
import {createSignal,createMemo,Show} from 'solid-js';
import {View} from '@pocketjs/framework/components';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {delay,fileChunks} from '@podjs/framework/services';
import {managedCache} from '../../../src/cache/host.ts';
import {prefetchInlineImages} from '../../../src/cache/prefetch.ts';
import {cacheEvictionOrder,cacheSizeLabel,cachePrefetchMode,type CacheFile} from '../../../src/cache/policy.ts';
import {advancedCacheRows} from '../../../src/ui/advanced-cache-settings.tsx';
import {TiledImage} from '../../../src/ui/TiledImage.tsx';
import {RemoteImage,remoteImageResourceCounts} from '../../../src/ui/RemoteImage.tsx';
import {SettingsStore} from '../../../src/settings/store.ts';
const metrics=getDisplayMetrics(),store=new SettingsStore();const [settings,setSettings]=createSignal(store.load());
const [current,setCurrent]=createSignal<{stage:string;row?:number;url?:string}|null>(null);const key='managed-cache-result';
const sleep=(ms:number)=>delay(ms).result;
function check(v:unknown,s:string):asserts v{if(!v)throw Error(s);}
async function waitFile(path:string,timeout=60000){const end=Date.now()+timeout;while(!(await fileChunks.stat(path)).file){if(Date.now()>end)throw Error('File timeout '+path);await sleep(100);}}
async function stage(stage:string,row?:number,url?:string){setCurrent({stage,row,url});await sleep(1600);if(stage==='tiled-image'){await managedCache.configure(0);check((await fileChunks.list('managed-cache/images')).entries.filter(f=>f.path.endsWith('.img')).length===1,'Tiled source lease was not retained');await managedCache.configure(512*1024*1024);}kv.set(key,{state:'running',stage,settings:store.load(),resources:remoteImageResourceCounts()});await waitFile('cache-advance-'+stage);setCurrent(null);await sleep(200);}
async function run(){
 await waitFile('cache-server.json');const {baseUrl}=JSON.parse((await fileChunks.readText('cache-server.json')).text);
 if((await fileChunks.stat('cache-warm')).file){await stage('warm-image',undefined,baseUrl+'/0.png');await sleep(300);kv.set(key,{state:'passed',stage:'warm-done',resources:remoteImageResourceCounts()});return;}
 const policyFiles:CacheFile[]=[...Array.from({length:8},(_,i)=>({path:'d'+i,bucket:'douyin-preload' as const,size:10,modified:i})),{path:'image',bucket:'images',size:10,modified:1},{path:'bili',bucket:'bili-preview',size:10,modified:1},{path:'offline',bucket:'rss-offline',size:1000,modified:0}];
 kv.set('managed-cache-native-policy',{evictions:[0,100,1020,1040,1050,1060,1070,1080,1090,1100].map(limit=>({limit,removed:cacheEvictionOrder(policyFiles,limit).map(f=>f.path)})),labels:[0,512,768,1024,1536,2048,2560,3072,4096].map(value=>({value,label:cacheSizeLabel(value)})),prefetch:['关闭','前 4 项','全部'].map(cachePrefetchMode)});
 await managedCache.configure(512*1024*1024);
 const a=managedCache.acquire(baseUrl+'/0.png'),b=managedCache.acquire(baseUrl+'/0.png');const [first,second]=await Promise.all([a.result,b.result]);check(first.path===second.path,'Shared file mismatch');
 await managedCache.configure(0);check((await fileChunks.stat(first.path)).file,'Leased image evicted');first.release();second.release();await managedCache.maintain();check(!(await fileChunks.stat(first.path)).file,'Released image retained above limit');check((await fileChunks.readText('managed-cache/rss-offline/kept.bin')).text==='offline-kept','Offline changed');check((await fileChunks.readText('reader-assets/kept.bin')).text==='resource-kept','Reader asset changed');
 await managedCache.configure(512*1024*1024);const blocks=Array.from({length:6},(_,i)=>({type:'image' as const,url:baseUrl+'/'+i+'.png'}));
 await prefetchInlineImages(managedCache,blocks,undefined,'关闭').done;await stage('prefetch-off');
 await prefetchInlineImages(managedCache,blocks,undefined,'前 4 项').done;await stage('prefetch-four');
 await prefetchInlineImages(managedCache,blocks,undefined,'全部').done;await stage('prefetch-all');
 const slow=prefetchInlineImages(managedCache,[0,1].map(i=>({type:'image' as const,url:baseUrl+'/slow'+i})),undefined,'全部');await waitFile('cache-slow-ready');slow.cancel();await slow.done;await managedCache.maintain();await stage('cancelled');
 await stage('cold-image',undefined,baseUrl+'/0.png');await stage('tiled-image',undefined,baseUrl+'/0.png');
 for(const [name,row,patch] of [['cache-min',0,{cacheLimitMb:512}],['cache-max',0,{cacheLimitMb:4096}],['media-off',1,{mediaCacheMode:'关闭'}],['media-four',1,{mediaCacheMode:'前 4 项'}],['media-all',1,{mediaCacheMode:'全部'}],['keep-off',2,{syncMediaKeepAlive:false}],['keep-on',2,{syncMediaKeepAlive:true}]] as const){setSettings(store.update(patch));await stage(name,row);}
 await sleep(300);kv.set(key,{state:'passed',stage:'done',resources:remoteImageResourceCounts(),offlinePreserved:true,readerAssetPreserved:true,leaseProtected:true,evictionAfterRelease:true});
}
function App(){return <Show when={current()} keyed>{value=>{
 const rows=createMemo(()=>advancedCacheRows({width:metrics.logicalWidth,height:metrics.logicalHeight,get state(){return settings();},onChange:p=>setSettings(store.update(p)),onNavigate:()=>{}},metrics.logicalWidth-36,1536*1024*1024));
 return value.stage==='tiled-image'?<View class="absolute left-[66] top-[66] w-[100] h-[100]"><TiledImage url={value.url!} geometry={{width:100,height:100,imageWidth:1024,imageHeight:1024,density:2}} state={{scale:1,x:0,y:0}} onSize={()=>{}} onError={error=>kv.set(key,{state:'failed',error:String(error)})}/></View>:value.url?<View class="absolute left-[66] top-[66] w-[100] h-[100]"><RemoteImage inline={value.stage==='cold-image'} url={value.url} width={100} height={100} onError={error=>kv.set(key,{state:'failed',error:String(error)})}/></View>:value.row!==undefined?<View class="absolute left-[18] right-[18] top-[35]" style={{height:rows()[value.row].height}}>{rows()[value.row].render()}</View>:<View/>;
 }}</Show>;}
mount(App);void run().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
