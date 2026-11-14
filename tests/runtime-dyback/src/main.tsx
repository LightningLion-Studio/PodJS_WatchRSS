import {mount} from '@pocketjs/framework/solid';
import {kv} from '@podjs/framework/watch';
import {createSignal,Show} from 'solid-js';
import {services} from '../../../src/services.ts';
import {initializeDebugBuild} from '../../../src/debug/host.ts';
import {installDouyinDebugTransport,douyinClient,douyinPreload,douyinStock} from '../../../src/media-services.ts';
import WatchRSS from '../../../src/ui/screen.tsx';
// This test entry never starts app-entry cloud/sync/onboarding services.
function App(){
 const [ready,setReady]=createSignal(false);
 void initializeDebugBuild().then(()=>{
 installDouyinDebugTransport({request(){console.error('DYBACK forbidden_transport');throw Error('fixture_network_forbidden');}});
 douyinClient.buildPlaybackHeaders=async()=>({});
 douyinPreload.lookup=async id=>`fixture-${Number(id.split('-').at(-1))%2}.mp4`;
 douyinPreload.readySource=async()=>undefined;
 douyinPreload.restoreFrame=async()=>({available:false});
 douyinPreload.previewFrame=async()=>undefined;
 douyinStock.restore=async()=>[];
 // Prevent inactive synthetic entry from restoring user metadata.
 douyinClient.restoreFeed=async()=>({items:[],anchorAwemeId:null,cursor:null,hasMore:false,savedAtMillis:0,resolved:{}});
 douyinClient.restorePlaybackQueue=douyinClient.restoreFeed;
 douyinClient.savePlaybackQueue=async()=>{};
 douyinClient.saveRecentWindow=async()=>{};
 douyinClient.recordHistory=async()=>{};
 kv.set('dyback.platform',kv.get<string>('dyback.platform')??'douyin');
 setReady(true);
 console.log('DYBACK fixture_ready');
 });
 return <Show when={ready()}><WatchRSS services={services}/></Show>;
}
mount(App);
