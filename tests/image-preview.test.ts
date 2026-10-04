import {expect,test} from "bun:test";
import {previewBase,previewPlacement,previewMaxScale,zoomPreview,nextPreviewScale,clampPreview,previewAllowsBack,previewCanStartBack,pinchPreviewStep,previewScaleDecayStep,previewPanDecayStep} from "../src/ui/image-preview.ts";
const geometry={width:233,height:233,imageWidth:120,imageHeight:60};
test("native image fit, maximum and double-tap cycle",()=>{expect(previewBase(geometry)).toEqual({width:233,height:116.5});expect(previewMaxScale(geometry)).toBe(8);expect([1,2,4].map(s=>nextPreviewScale(geometry,s))).toEqual([2,4,1]);});
test("zoom keeps tapped content under the finger and clamps pan to real bounds",()=>{const state=zoomPreview(geometry,{scale:1,x:0,y:0},2,80,116.5);expect(state).toEqual({scale:2,x:36.5,y:0});expect(previewAllowsBack(geometry,state)).toBe(false);expect(clampPreview(geometry,{scale:2,x:999,y:999})).toEqual({scale:2,x:116.5,y:0});expect(previewAllowsBack(geometry,{scale:2,x:116.5,y:0})).toBe(true);});
test("pinch scale is bounded and invalid offsets cannot poison rendering",()=>{expect(clampPreview(geometry,{scale:100,x:NaN,y:Infinity})).toEqual({scale:8,x:0,y:0});expect(clampPreview(geometry,{scale:-1,x:99,y:99})).toEqual({scale:.5,x:0,y:0});});

test("original image pixel dimensions account for display density",()=>{const dense={width:233,height:233,imageWidth:4000,imageHeight:2000,density:2};expect(previewMaxScale(dense)).toBeCloseTo(4000*4/466);expect(previewAllowsBack(dense,{scale:2,x:116,y:0})).toBe(true);expect(previewAllowsBack(dense,{scale:2,x:115.75,y:0})).toBe(false);});

test("image placement follows native integer physical pixel centering",()=>{expect(previewPlacement({...geometry,density:2})).toEqual({width:233,height:116.5,left:0,top:58.5});});

test("image swipe-back starts in the native left region only when horizontal pan is exhausted",()=>{
 const g={...geometry,density:2},edge=previewMaxScale(g);
 expect(previewCanStartBack(g,{scale:1,x:0,y:0},151,24,2)).toBe(true);
 expect(previewCanStartBack(g,{scale:1,x:0,y:0},152,24,2)).toBe(false);
 expect(previewCanStartBack(g,{scale:2,x:0,y:0},20,24,2)).toBe(false);
 expect(previewCanStartBack(g,{scale:2,x:116.5,y:0},20,24,2)).toBe(true);
 expect(previewCanStartBack(g,{scale:edge,x:0,y:0},20,2,24)).toBe(false);
});

test("pinch follows the native centroid formula and scale decay friction",()=>{
 const initial={scale:2,x:20,y:0};
 const next=pinchPreviewStep(geometry,initial,1.25,150,116.5,5,0);
 expect(next.scale).toBe(2.5);expect(next.x).toBeCloseTo(21.625);expect(next.y).toBe(0);
 const ignoredPan=pinchPreviewStep(geometry,initial,1,150,116.5,0,0);
 expect(ignoredPan).toEqual(initial);
 const decay=previewScaleDecayStep(geometry,initial,2,.02),factor=Math.exp(-4.2*13.6*.02);
 expect(decay.state.scale).toBeCloseTo(2+2*(1-factor)/(4.2*13.6));
 expect(decay.velocity).toBeCloseTo(2*factor);
 expect(previewScaleDecayStep(geometry,{scale:8,x:0,y:0},2,.02).velocity).toBe(0);
 const pan=previewPanDecayStep(geometry,{scale:2,x:0,y:0},100,0,.02),panFactor=Math.exp(-4.2*.9*.02);
 expect(pan.state.x).toBeCloseTo(100*(1-panFactor)/(4.2*.9));
 expect(pan.vx).toBeCloseTo(100*panFactor);
 expect(previewPanDecayStep(geometry,{scale:2,x:116.5,y:0},100,0,.02).vx).toBe(0);
});
