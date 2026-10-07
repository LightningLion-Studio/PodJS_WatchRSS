import { expect, test } from "bun:test";
import { createComposeFontScale } from "../src/ui/compose-font-scale.ts";
import { createComposeFontScale as oldFontScale } from "./fixtures/upstream-u4/compose-font-scale.ts";
import { safeQrLayout, rectInsideCircle } from "../src/ui/safe-qr-layout.ts";
import { safeQrLayout as oldLayout, rectInsideCircle as oldInside } from "./fixtures/upstream-u4/safe-qr-layout.ts";

test("U4 Float32 conversion matches frozen dc26f46 including cache history", () => {
  let seed = 41;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  for (let run = 0; run < 20; run++) {
    const current = createComposeFontScale(), old = oldFontScale();
    const scales = [1.04,1.05,1.0500001,1.02999,1.03,2.5,2.25, ...Array.from({length:100}, () => 0.5 + random()*3)];
    if (run % 2) scales.reverse();
    for (const scale of scales) {
      const density = 0.5 + random()*3, value = random()*300 - 100;
      expect(current.spToPx(value,density,scale)).toBe(old.spToPx(value,density,scale));
      expect(current.dpToSp(value,scale)).toBe(old.dpToSp(value,scale));
      expect(current.lineHeightPx(value,24,density,scale)).toBe(old.lineHeightPx(value,24,density,scale));
    }
  }
});

test("U4 geometry matches frozen dc26f46 across aspect ratios, boundaries and margins", () => {
  for (const w of [0,1,80,160,192,233,280,466,512]) for (const h of [1,160,233,280,466]) {
    const layout = safeQrLayout(w,h), old = oldLayout(w,h);
    expect(layout).toEqual(old);
    for (const rect of [layout.title,layout.qr,layout.status,layout.action,{x:0,y:0,width:w,height:h}]) {
      for (const margin of [undefined,0,1,layout.scale,20]) expect(rectInsideCircle(rect,layout,margin)).toBe(oldInside(rect,old,margin));
    }
  }
});

test("U4 startup differential runs with the production browser conditions in isolation", async () => {
  const child = Bun.spawn([process.execPath,"--conditions=browser","test",`${import.meta.dir}/upstream-u4-startup.isolated.ts`], {stdout:"pipe",stderr:"pipe"});
  const [exit,stdout,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect({exit,output:exit ? stdout+stderr : ""}).toEqual({exit:0,output:""});
});
