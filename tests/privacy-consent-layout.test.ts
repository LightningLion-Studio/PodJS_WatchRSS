import {expect,test} from 'bun:test';
import {rectInsideCircle} from '@podjs/framework/watch-ui';
import {privacyConsentLayout} from '../src/ui/privacy-consent-layout.ts';

test('privacy consent fits above the buttons on a round screen at default and maximum font scale',()=>{
 const measure=(text:string,slot:number)=>Array.from(text).length*({0:12,1:14,3:18,10:18}[slot]??0);
 for (const width of [192,233]) {
  const circle={cx:width/2,cy:width/2,radius:width/2};
  const normal=privacyConsentLayout(width,width,true,1,measure)!;
  const maximum=privacyConsentLayout(width,width,true,1.24,measure)!;
  const larger=privacyConsentLayout(width,width,true,2,measure)!;
  expect(maximum.notice.caption.fontSize).toBeGreaterThan(normal.notice.caption.fontSize);
  for (const layout of [normal,maximum,larger]) {
   const {title,notice,link,disagree,agree}=layout;
   expect(title.y).toBeLessThan(width/4);
   expect(title.y+title.height).toBeLessThan(notice.y);
   expect(notice.y+notice.height).toBeLessThan(link.y);
   expect(link.y+link.height).toBeLessThan(Math.min(disagree.y,agree.y));
   expect(disagree.x+disagree.width).toBeLessThan(agree.x);
   expect(link.caption.lines.join('')).toBe('查看《隐私政策》');
   for (const box of [title,notice,link,disagree,agree]) {
    expect(rectInsideCircle(box,circle,3)).toBe(true);
    expect(box.caption.width).toBeLessThanOrEqual(box.width);
    expect(box.caption.height).toBeLessThanOrEqual(box.height);
   }
  }
 }
});
