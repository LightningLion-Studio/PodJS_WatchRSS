import {defineBackgroundHandler} from '@podjs/framework/background-handler';
import {SYNC_V2_PRODUCT_ENABLED} from '../sync-v2/gate';
import {CloudSyncDeadlineError} from './execution';
import {runSyncV2Background} from './background-v2';
export default defineBackgroundHandler(async context=>{
 if(!SYNC_V2_PRODUCT_ENABLED)return 'success';
 return runSyncV2Background(context);
},{yieldTurn:async context=>{
 if(context.isCancelled())throw Error('cloud_sync_suspended');
 if(Date.now()>=context.deadlineMs-10000)throw new CloudSyncDeadlineError();
 await context.request!('cloud.host',{method:'runtime.delay',args:{milliseconds:1}});
}});
