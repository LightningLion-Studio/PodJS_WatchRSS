import {startWatchRssApp} from './app-entry.tsx';
import {initializeDebugBuild} from './debug/host.ts';
import {installDouyinDebugTransport,mediaTransport} from './media-services.ts';
import {secureStorage} from '@podjs/framework/services';
import {services} from './services.ts';
import {origin,cookie} from '../tests/runtime-dystock/runtime-config.generated.ts';
import {loopbackFeedTransport} from '../tests/runtime-dystock/src/transport.ts';

startWatchRssApp(async()=>{
 // This entry is used only by the dedicated emulator fixture build. No real cookie is imported.
 await initializeDebugBuild();
 installDouyinDebugTransport(loopbackFeedTransport(origin,mediaTransport));
 if(await secureStorage.get('douyin.cookie')!==cookie)await secureStorage.set('douyin.cookie',cookie);
 void services.addChannel('https://www.douyin.com').then(()=>console.log('DYSTOCK_FIXTURE channel_ready'),()=>console.error('DYSTOCK_FIXTURE channel_failed'));
 console.log('DYSTOCK_FIXTURE transport_ready');
 // The root is already mounted; production content opens only after this setup.
});
