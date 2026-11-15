import type {BackgroundOutcome} from '@podjs/framework/background-handler';
import {CLOUD_HOST_CAPABILITY_UNAVAILABLE} from './execution';
export function cloudBackgroundOutcome(success:boolean,authorized:boolean,status:{errorCode?:string;retryable?:boolean;continuationReady?:boolean;yieldedToWriter?:boolean}):BackgroundOutcome{
 if(!success&&status.yieldedToWriter)return 'busy';
 if(!success&&status.errorCode===CLOUD_HOST_CAPABILITY_UNAVAILABLE)return 'failure';
 if(!success&&['cloud_snapshot_progress_stalled','cloud_snapshot_work_timeout'].includes(status.errorCode??''))return {status:'retry',retryClass:'bounded'};
 if(!success&&authorized&&status.continuationReady)return {status:'retry',progress:true};
 return success||status.retryable===false?'success':'retry';
}
