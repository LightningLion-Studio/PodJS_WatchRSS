import type {RouteEntry} from '../ui/routes/types.ts';

export function isImmersiveDouyin(entry:RouteEntry):boolean {
 return entry.page==='video'&&(entry.playback
  ?entry.playback.platform==='douyin'&&entry.playback.immersive===true
  :entry.videoTarget?.kind==='douyin'&&entry.videoTarget.immersive===true);
}
/** player-detail-panel uses the existing root pan recognizer to dispatch both
 * directions through player.sideSwipe. Leave that recognizer in charge when
 * its port is installed; otherwise observe only rightward Back below. */
export function usesImmersiveBackObserver(entry:RouteEntry):boolean {
 return isImmersiveDouyin(entry)&&!Object.hasOwn(entry.player??{},'sideSwipe');
}
/** Immersive feed is a home-level experience. Discard its title/intermediate
 * routes on Back; detail players and other platforms keep their parent. */
export function backStackSize(entries:readonly RouteEntry[]):number {
 return entries.length>1&&isImmersiveDouyin(entries[entries.length-1])?1:Math.max(1,entries.length-1);
}
