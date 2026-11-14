import {expect,test} from 'bun:test';
import {PlayerAnimationDiagnostics} from '../src/ui/player-animation-diagnostics.ts';
test('animation diagnostics emit one closed summary and estimate guest-frame misses',()=>{
 let now=100;const lines:string[]=[];const stats=new PlayerAnimationDiagnostics(s=>lines.push(s),()=>now,10);
 stats.begin('swipe','expanded',90);now=110;stats.frame();now=150;stats.frame();expect(lines).toHaveLength(0);
 stats.end('swipe');stats.end('swipe');expect(lines).toHaveLength(1);
 expect(JSON.parse(lines[0])).toEqual({kind:'swipe',mode:'expanded',angle:90,frames:2,maxFrameMs:40,droppedFrames:3,elapsedMs:50,outcome:'complete',clock:'guest-frame',frameBudgetMs:10});
});
test('overlap and exit finish bounded counters once without a per-frame log',()=>{
 const lines:string[]=[];const stats=new PlayerAnimationDiagnostics(s=>lines.push(s),()=>100);
 stats.begin('rotation','standard',90);stats.begin('rotation','shrunk',180);stats.begin('scale','expanded',180);
 for(let n=0;n<100;n++)stats.frame(100+n);expect(lines).toHaveLength(1);stats.close();stats.close();expect(lines).toHaveLength(3);
 expect(lines.every(s=>!s.includes('url')&&!s.includes('sourceId'))).toBe(true);
});
