import {expect,test} from 'bun:test';
import {backStackSize,usesImmersiveBackObserver} from '../src/navigation/back-target.ts';
import type {RouteEntry} from '../src/ui/routes/types.ts';
const home:RouteEntry={page:'home'},entry:RouteEntry={page:'douyin',douyinRoute:{name:'entry'}};
for(const platform of ['douyin','bili','rss'] as const)for(const immersive of [false,true])test(`DYBACK ${platform} immersive=${immersive} destination`,()=>{
 const video:RouteEntry={page:'video',playback:{platform,immersive,title:'fixture'}};
 const stack=[home,entry,{page:'saved'} as RouteEntry,video];
 const size=backStackSize(stack);
 expect(stack.slice(0,size).at(-1)?.page).toBe(platform==='douyin'&&immersive?'home':'saved');
 expect(stack).toHaveLength(4);
});
test('DYBACK menus above immersive video return to video before exiting',()=>{
 const video:RouteEntry={page:'video',playback:{platform:'douyin',immersive:true,title:'fixture'}};
 expect(backStackSize([home,entry,video,{page:'douyin',douyinRoute:{name:'entry'}}])).toBe(3);
});
test('DYBACK restored immersive target exits to home before playback is resolved',()=>{
 expect(backStackSize([home,entry,{page:'video',videoTarget:{kind:'douyin',awemeId:'fixture',immersive:true}}])).toBe(1);
 expect(backStackSize([home])).toBe(1);
});
test('DYBACK detail-panel port retains its existing signed-direction dispatcher',()=>{
 const video:RouteEntry={page:'video',playback:{platform:'douyin',immersive:true,title:'fixture'}};
 expect(usesImmersiveBackObserver(video)).toBe(true);
 // Same port name as the in-progress player-detail-panel worktree. No detail UI.
 video.player=Object.assign({} as NonNullable<RouteEntry['player']>,{sideSwipe:{begin(){return true;},move(){},end(){}}});
 expect(usesImmersiveBackObserver(video)).toBe(false);
 expect(backStackSize([home,entry,video])).toBe(1);
 expect(usesImmersiveBackObserver({page:'video',playback:{platform:'bili',title:'fixture'}})).toBe(false);
});
