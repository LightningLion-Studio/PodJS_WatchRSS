import type {ActivityState} from '@podjs/framework/services';
import {restoreActivityNavigation,type ActivityRoute} from './activity-navigation.ts';

/** Android supplies this state from the current task's Bundle, never app KV.
 * A missing/invalid content snapshot starts at home. Media sessions are not
 * restorable: mounting a video route starts playback, so resume its parent
 * instead. The saved queue/progress stays available for an explicit play action. */
export function startupActivityNavigation(state:ActivityState,debug=false):ActivityRoute[]|null {
 const entries=restoreActivityNavigation(state,debug);
 if(!entries)return null;
 const media=entries.findIndex(entry=>entry.page==='video'||entry.page==='speech-playback');
 return media<0?entries:entries.slice(0,media);
}
