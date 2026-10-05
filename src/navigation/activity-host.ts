import {application} from '@podjs/framework/services';
import {ActivityStateHub} from './activity-state.ts';
export const activityStateHub=new ActivityStateHub(state=>application.activityState.write(state));
