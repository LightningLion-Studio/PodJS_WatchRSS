import {expect, test} from 'bun:test';
import {roundTextShift} from '../src/reader/round-text.ts';
import {rectInsideCircle} from '../src/ui/safe-qr-layout.ts';

test('an expanded reader line moves off the polar edge and retains its central position', () => {
  const width = 233, height = 233, left = 18, textWidth = 125, lineHeight = 17;
  const top = 182;
  const shift = roundTextShift(width, height, top, lineHeight, left, textWidth);
  expect(shift).toBeGreaterThan(0);
  expect(rectInsideCircle({x:left+shift!,y:top,width:textWidth,height:lineHeight},
    {cx:width/2,cy:height/2,radius:height/2},3)).toBe(true);
  expect(roundTextShift(width,height,100,lineHeight,left,textWidth)).toBe(0);
});

test('a line with no room becomes visible after scrolling into a wider chord', () => {
  expect(roundTextShift(233,233,204,17,14,172)).toBeUndefined();
  expect(roundTextShift(233,233,158,17,14,172)).toBeDefined();
});
