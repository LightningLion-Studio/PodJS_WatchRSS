import {expect,test} from 'bun:test';
import {readerControlViewport} from '../../src/reader/viewport.ts';

test('every corner of the round notice viewport stays inside the screen circle',()=>{
 for(const [width,height] of [[233,233],[240,240],[300,300],[233,210]]){
  const frame=readerControlViewport(width,height,true,true),radius=Math.min(width,height)/2;
  for(const x of [frame.left,frame.left+frame.width])for(const y of [frame.top,frame.top+frame.height]){
   expect(Math.hypot(x-width/2,y-height/2)).toBeLessThan(radius);
  }
  expect(frame.width).toBe(frame.height);
 }
});

test('notices on square screens and vertical scroll retain their original positions',()=>{
 for(const [round,pageMode] of [[false,true],[false,false],[true,false]]){
  expect(readerControlViewport(233,240,round!,pageMode!)).toEqual({left:0,top:0,width:233,height:240});
 }
});
