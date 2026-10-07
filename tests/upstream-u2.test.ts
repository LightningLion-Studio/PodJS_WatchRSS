import {expect,test} from "bun:test";
import {BackMotion} from "@podjs/framework/navigation";
import {watchProgressArc} from "@podjs/framework/watch-ui";
import {BackMotion as BeforeMotion} from "./fixtures/upstream-u2/back-motion.ts";
import {watchProgressArc as beforeArc} from "./fixtures/upstream-u2/watch-progress-animation.ts";
test("U2 arc is exactly equal to pre-migration output over two cycles",()=>{
 for(const stroke of [0,1,3,4,6]) for(let t=-1;t<=13320;t+=7) expect(watchProgressArc(t,stroke)).toEqual(beforeArc(t,stroke));
 for(const t of [NaN,Infinity,-Infinity]) expect(watchProgressArc(t)).toEqual(beforeArc(t));
});
test("U2 motion preserves thresholds, easing, phase and commit/cancel outputs",()=>{
 for(const width of [180,233,466]) for(const fraction of [-.1,0,.119,.12,.399,.4,1,1.2])
 for(const velocity of [-900,0,500,501,900]) for(const cancelled of [false,true]) for(const force of [false,true]) {
  const a=new BeforeMotion(width),b=new BackMotion(width);
  const same=()=>expect({offset:b.offset,phase:b.phase}).toEqual({offset:a.offset,phase:a.phase});
  a.begin(5);b.begin(5);same();a.move(width*fraction);b.move(width*fraction);same();
  a.release(velocity,100,cancelled,force);b.release(velocity,100,cancelled,force);same();
  for(const time of [99,100,110,150,199,200,219,220,319,320,400]) {expect(b.tick(time)).toBe(a.tick(time));same();}
  a.reset();b.reset();same();expect(b.tick(500)).toBe(a.tick(500));
 }
});
