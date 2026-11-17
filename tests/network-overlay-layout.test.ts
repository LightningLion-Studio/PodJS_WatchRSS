import {test,expect} from 'bun:test';
import {rectInsideCircle} from '../src/ui/safe-qr-layout.ts';
import {readFileSync} from 'node:fs';
/** Four-corner contract, independent of the renderer and rounded clipping. */
test('overlay visible rectangles stay within a round display at every supported scale',()=>{
 const rects=[{x:71.5,y:18,width:90,height:29},{x:26.5,y:57,width:180,height:28},
  {x:12.5,y:89,width:208,height:42},{x:12.5,y:103,width:208,height:42},
  {x:21.5,y:139,width:190,height:22},{x:21.5,y:153,width:190,height:22},
  {x:76.5,y:172.5,width:80,height:45}];
 for(const size of [192,233,320,384,390,466]){
  const scale=size/233;
  for(const rect of rects)expect(rectInsideCircle({x:rect.x*scale,y:rect.y*scale,width:rect.width*scale,height:rect.height*scale},{cx:size/2,cy:size/2,radius:size/2},2*scale)).toBe(true);
 }
});
test('copy and controls come from onboarding; overlay intercepts background taps',()=>{
 const overlay=readFileSync(new URL('../src/ui/NetworkUnavailableOverlay.tsx',import.meta.url),'utf8');
 expect(overlay).toContain('networkMessages,NetworkAvailabilityStatusBar,OnboardingPrimaryButton');
 expect(overlay).toContain('bg-[#000000f0]');expect(overlay).toContain('onPress={()=>{}}');expect(overlay).toContain('text="重试"');
});
