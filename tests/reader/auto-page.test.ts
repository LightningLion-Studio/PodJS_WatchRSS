import {expect,test} from 'bun:test';
import {AutoPageClock} from '../../src/reader/auto-page.ts';
test('auto page uses seconds per page, never catches up missed background pages, and resets after interval changes',()=>{
 const clock=new AutoPageClock();
 expect(clock.tick(0,true,5)).toBe(false);expect(clock.tick(4999,true,5)).toBe(false);expect(clock.tick(5000,true,5)).toBe(true);
 expect(clock.tick(5001,true,5)).toBe(false);
 clock.tick(60000,false,5);expect(clock.tick(100000,true,5)).toBe(false);expect(clock.tick(105000,true,5)).toBe(true);
 expect(clock.tick(106000,true,10)).toBe(false);expect(clock.tick(115999,true,10)).toBe(false);expect(clock.tick(116000,true,10)).toBe(true);
 expect(clock.tick(115000,true,10)).toBe(false);
});
