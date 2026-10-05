import {appLogger} from './app-logger.ts';
import {telemetryScreen,telemetryScreenOwner} from '../telemetry/screens.ts';
import type {RouteEntry} from '../ui/routes/types.ts';

/** The existing native Activity mapping also owns log identity. Internal pager
 * changes, titles and scroll offsets must not produce lifecycle log entries. */
export class ActivityLog {
 private seen=new WeakSet<RouteEntry>();
 private owner:RouteEntry|undefined;
 private active=false;
 update(entries:RouteEntry[],active:boolean):void {
  const owner=telemetryScreenOwner(entries),name=owner&&telemetryScreen(owner);
  if(owner&&name){
   if(!this.seen.has(owner)){this.seen.add(owner);appLogger.d('Activity',`启动: ${name}`);}
   if(active&&(!this.active||this.owner!==owner))appLogger.d('Activity',`活跃: ${name}`);
  }
  this.owner=owner;this.active=active;
 }
}
