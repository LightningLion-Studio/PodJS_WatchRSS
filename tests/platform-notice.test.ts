import {expect,test} from 'bun:test';
import {createPlatformNoticeRoute,INITIAL_DISCLOSURE_KEY} from '../src/announcement/platform.ts';
function disk(){const m=new Map<string,unknown>();return {m,get:<T>(k:string)=>m.get(k) as T|undefined,set:<T>(k:string,v:T)=>{m.set(k,v);}};}
test('home notice priority delays initial dialog; acknowledgements persist and cannot be dismissed',()=>{
 const storage=disk(),home=createPlatformNoticeRoute(storage,{page:'home'});expect(home.pending(true)).toBeUndefined();expect(home.pending()?.confirm).toBe('我已了解');expect(home.dismiss()).toBe(false);home.acknowledge();expect(storage.m.get(INITIAL_DISCLOSURE_KEY)).toBe(true);expect(createPlatformNoticeRoute(storage,{page:'oobe'}).pending()).toBeUndefined();
});
test('platform entry confirms after initial and on every fresh entry; login/player have persistent compact labels',()=>{
 const storage=disk(),entry=createPlatformNoticeRoute(storage,{page:'douyin',name:'entry'});entry.acknowledge();expect(entry.pending()?.paragraphs.join('')).toContain('未获其授权');expect(entry.pending()?.confirm).toBe('知道了，继续');entry.acknowledge();expect(entry.pending()).toBeUndefined();
 expect(createPlatformNoticeRoute(storage,{page:'douyin',name:'entry'}).pending()?.confirm).toBe('知道了，继续');
 const login=createPlatformNoticeRoute(storage,{page:'bili',name:'login'});expect(login.pending()).toBeUndefined();expect(login.notice?.compact).toBe(true);expect(login.notice?.paragraphs[0]).toContain('哔哩哔哩');
 expect(createPlatformNoticeRoute(storage,{page:'account-status'}).notices.map(n=>n.paragraphs[0])).toEqual([expect.stringContaining('哔哩哔哩'),expect.stringContaining('抖音')]);
 expect(createPlatformNoticeRoute(storage,{page:'video',platform:'rss'}).notice).toBeUndefined();expect(createPlatformNoticeRoute(storage,{page:'account-status'}).access?.title).toBe('手机版设备授权包');
});
