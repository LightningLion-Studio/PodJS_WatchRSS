import {describe,test,expect} from 'bun:test';
import {shareActionEnabled,shareQrPresentation,CHANNEL_SHARE_QR_HINT,systemShareSupported,nativeShareText,routeShare,qrShareInput,biliShareLink,biliActionTitle,douyinShareLink} from '../src/sharing/policy.ts';
describe('native sharing policy',()=>{
 test('action gates use Kotlin whitespace and absent QR links notify without opening a page',async()=>{
  expect(shareActionEnabled('title','\t\u2002 ',false)).toBe(false);
  expect(shareActionEnabled('title',null,true)).toBe(true);
  expect(shareActionEnabled('\u2002',null,true)).toBe(false);
  expect(shareActionEnabled('\ufeff',null,true)).toBe(true);
  // Native actions permit link-only input, even though the detail text helper rejects a blank title.
  expect(shareActionEnabled('', ' URL ',true)).toBe(true);
  const events:string[]=[],ports={text:async()=>{events.push('system');},qr:()=>{events.push('qr');},unavailable:()=>{events.push('missing');}};
  expect(await routeShare({origin:'detail',title:'title',link:'\t'},false,ports)).toBe('none');
  expect(events).toEqual(['missing']);
  expect(await routeShare({origin:'detail',title:'\u2002',link:'URL'},true,ports)).toBe('none');
  expect(events).toEqual(['missing']);
 });
 test('QR titles and channel hints follow the native trimming fallback',()=>{
  expect(shareQrPresentation('\u2002',' URL ')).toEqual({title:'扫码分享',link:'URL',subtitle:'URL'});
  expect(shareQrPresentation(' 标题 ',' URL ',CHANNEL_SHARE_QR_HINT)).toEqual({title:'标题',link:'URL',subtitle:'请在扫码后选择分享给RSS阅读器\n或复制链接粘贴到RSS阅读器里'});
  expect(shareQrPresentation('标题','URL','\t')).toEqual({title:'标题',link:'URL',subtitle:'URL'});
 });
 test('system preference is available only on API 31+ non Wear OS',()=>{
  for(const sdkInt of [23,30,31,35])for(const wearOs of [false,true])expect(systemShareSupported({sdkInt,wearOs})).toBe(sdkInt>=31&&!wearOs);
  expect(systemShareSupported(null)).toBe(false);
 });
 test('channel and Bili detail trim while reader preserves raw text and rejects blank title',()=>{
  for(const origin of ['channel','bili-detail'] as const){
   expect(nativeShareText({origin,title:' \u2002标题\t',link:'\n https://例子.test/a \u2002'})).toBe('标题\nhttps://例子.test/a');
   expect(nativeShareText({origin,title:' ',link:' URL '})).toBe('URL');
   expect(nativeShareText({origin,title:' title ',link:null})).toBe('title');
   expect(nativeShareText({origin,title:'\t',link:'\n'})).toBeNull();
  }
  expect(nativeShareText({origin:'detail',title:' title ',link:' URL '})).toBe(' title \n URL ');
  expect(nativeShareText({origin:'detail',title:' title ',link:'\n'})).toBe(' title ');
  expect(nativeShareText({origin:'detail',title:'\u2002',link:'URL'})).toBeNull();
 });
 test('only QR requires a link; chooser failures propagate without opening a QR page',async()=>{
  const calls:string[]=[];const ports={text:async(text:string)=>{calls.push(text);},qr:()=>{calls.push('qr');}};
  expect(await routeShare({origin:'detail',title:'Title'},true,ports)).toBe('system');
  expect(await routeShare({origin:'detail',title:'Title'},false,ports)).toBe('none');
  expect(await routeShare({origin:'detail',title:' ',link:'URL'},true,ports)).toBe('none');
  expect(await routeShare({origin:'detail',title:' ',link:'URL'},false,ports)).toBe('qr');
  expect(calls).toEqual(['Title','qr']);
  await expect(routeShare({origin:'channel',title:'Title'},true,{...ports,text:async()=>{throw new Error('unavailable');}})).rejects.toThrow('unavailable');
  expect(calls).toEqual(['Title','qr']);
  expect(qrShareInput({origin:'detail',title:' Title ',link:' URL '})).toEqual({title:'Title',link:'URL'});
 });
 test('video URLs retain native long ids and do not percent encode Douyin ids',()=>{
  expect(biliShareLink(' BV123 ',42)).toBe('https://www.bilibili.com/video/BV123');
  expect(biliShareLink('', '9223372036854775807')).toBe('https://www.bilibili.com/video/av9223372036854775807');
  expect(biliShareLink(undefined,0)).toBe('https://www.bilibili.com/video/av0');
  expect(biliShareLink(undefined,undefined)).toBeNull();
  expect(biliActionTitle(' 标题 ','BV',42)).toBe('标题');
  expect(biliActionTitle('',undefined,0)).toBe('av0');
  expect(biliActionTitle('', ' BV123 ',42)).toBe('BV号 BV123');
  expect(douyinShareLink(' 中文/123 ')).toBe('https://www.douyin.com/video/中文/123');
 });
});
