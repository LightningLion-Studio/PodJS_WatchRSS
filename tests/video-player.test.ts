import { describe, expect, test } from "bun:test";
import { formatPlayerTime, guardedCrownVolume, nextScaleMode, playerPanRange, playerScale, progressWidth, seekHoldStep } from "../src/ui/video-player.ts";

describe("video player helpers", () => {
  test("cycles the Android scale modes", () => {
    expect(nextScaleMode("standard")).toBe("expanded");
    expect(nextScaleMode("expanded")).toBe("shrunk");
    expect(nextScaleMode("shrunk")).toBe("standard");
  });
  test("formats unknown, short and hour durations", () => {
    expect(formatPlayerTime(0)).toBe("--:--");
    expect(formatPlayerTime(65_000)).toBe("1:05");
    expect(formatPlayerTime(3_665_000)).toBe("1:01:05");
  });
  test("matches four second accelerating hold seeks", () => {
    expect(seekHoldStep(0, 1)).toBe(4_000);
    expect(seekHoldStep(2_000, -1)).toBe(-7_290);
    expect(seekHoldStep(30_000, 1)).toBe(60_000);
  });
  test("clamps progress", () => {
    expect(progressWidth(-1, 100, 160)).toBe(0);
    expect(progressWidth(50, 100, 160)).toBe(80);
    expect(progressWidth(200, 100, 160)).toBe(160);
  });
  test("uses contain, cover and circle-safe shrink geometry", () => {
    expect(playerScale("standard", 233, 233, 1920, 1080)).toEqual({ scaleX: 1, scaleY: 0.5625 });
    expect(playerScale("expanded", 233, 233, 1920, 1080)).toEqual({ scaleX: 16 / 9, scaleY: 1 });
    expect(playerScale("shrunk", 233, 233, 1920, 1080).scaleX).toBeLessThan(1);
    expect(playerPanRange("expanded", 233, 233, 1920, 1080)).toEqual({ axis: "x", range: expect.any(Number) });
    expect(playerPanRange("standard", 233, 233, 1080, 1920)).toEqual({ axis: "y", range: 0 });
    expect(playerPanRange("expanded", 233, 233, 1920, 1080, 90).axis).toBe("y");
  });
  test("caps the first continuous crown raise from low volume", () => {
    const first = guardedCrownVolume(.1, .3, 16, true, { lastEventMs: Number.NEGATIVE_INFINITY }, 1_000);
    expect(first.volume).toBe(.2);
    const capped = guardedCrownVolume(first.volume, .3, 16, true, first.state, 1_200);
    expect(capped.volume).toBe(.21);
    const afterPause = guardedCrownVolume(capped.volume, .3, 16, true, capped.state, 2_000);
    expect(afterPause.volume).toBeCloseTo(.31);
  });
});

test("player crown gain is one third with fractional steps and reverse motion",()=>{
 let volume=.5,state={lastEventMs:Number.NEGATIVE_INFINITY};
 for(let i=0;i<3;i++){const next=guardedCrownVolume(volume,1/16,16,false,state,1000*i);volume=next.volume;state=next.state;}
 expect(volume).toBeCloseTo(.5+1/16);
 for(let i=0;i<3;i++){const next=guardedCrownVolume(volume,-1/16,16,false,state,4000+1000*i);volume=next.volume;state=next.state;}
 expect(volume).toBeCloseTo(.5);
});
