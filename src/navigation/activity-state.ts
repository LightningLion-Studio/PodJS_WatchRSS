import {ActivityStateHub as FrameworkActivityStateHub} from '@podjs/framework/navigation';
import {traceServiceWork} from '@podjs/framework/service-trace';
import type {ActivityState} from '@podjs/framework/services';

export class ActivityStateHub extends FrameworkActivityStateHub {
 constructor(publish:(state:ActivityState)=>Promise<void>){
  super(state=>traceServiceWork('navigation.activityPublish',()=>publish(state)));
 }
}
