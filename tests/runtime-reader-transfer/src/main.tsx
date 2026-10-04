import {mount} from '@pocketjs/framework/solid';
import {onCleanup} from 'solid-js';
import WatchRSS from '../../../src/ui/screen.tsx';
import {services} from '../../../src/services.ts';
import {startApplicationForegroundSync} from '../../../src/sync/application-host.ts';
import {readerPreviewSession as preview} from '../../../src/reader/preview-host.ts';
import {kv} from '@podjs/framework/watch';
import {delay} from '@podjs/framework/services';
import {systemTextResourceCounts} from '@podjs/framework/text';
import {mediaSurfaceOwners} from '@podjs/framework/media-surface';
function App(){
 const sync=startApplicationForegroundSync();let disposed=false;
 onCleanup(()=>{disposed=true;void sync.dispose();});
 void (async()=>{await sync.ready;let previous='';while(!disposed){const state={ready:true,stage:preview.state()?.preset.name??'idle',text:systemTextResourceCounts(),mediaOwners:mediaSurfaceOwners()},value=JSON.stringify(state);if(value!==previous){kv.set('reader-transfer-state',state);previous=value;}await delay(150).result;}})().catch(error=>kv.set('reader-transfer-state',{error:String(error)}));
 return <WatchRSS services={services} onSyncMediaKeepAliveChange={enabled=>sync.setMediaEnabled(enabled)}/>;
}
mount(App);
