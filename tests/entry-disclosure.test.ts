import {expect,test} from 'bun:test';
import {entryDisclosure} from '../src/ui/entry-disclosure.ts';
function disk(){const m=new Map<string,unknown>();return {get:<T>(k:string)=>m.get(k) as T|undefined,set:<T>(k:string,v:T)=>{m.set(k,v);}};}
test('entry disclosure is one session per owner: initial, then platform, then nothing',()=>{
 const storage=disk(),owner={},session=entryDisclosure(owner,{page:'bili',name:'entry'},storage),shown=()=>session.pending()?.confirm;
 expect(entryDisclosure(owner,{page:'bili',name:'entry'},storage)).toBe(session);
 expect(shown()).toBe('我已了解');session.confirm();
 expect(shown()).toBe('知道了，继续');session.confirm();
 expect(shown()).toBeUndefined();
 expect(entryDisclosure({},{page:'bili',name:'entry'},storage).pending()).toBeUndefined();
 expect(entryDisclosure({},{page:'home'},storage).pending()).toBeUndefined();

});
test('home disclosure waits for announcements and push messages',()=>{
 const home=entryDisclosure({},{page:'home'},disk());
 expect(home.pending(true)).toBeUndefined();
 expect(home.pending(false)?.title).toBe('使用前说明');
});

test('platform acknowledgement is independent and only saved after confirmation',()=>{
 const storage=disk();
 const bili=entryDisclosure({},{page:'bili',name:'entry'},storage);
 bili.confirm();
 expect(entryDisclosure({},{page:'bili',name:'entry'},storage).pending()?.confirm).toBe('知道了，继续');
 bili.confirm();
 expect(entryDisclosure({},{page:'bili',name:'entry'},storage).pending()).toBeUndefined();
 const douyin=entryDisclosure({},{page:'douyin',name:'entry'},storage);
 expect(douyin.pending()?.confirm).toBe('知道了，继续');
 douyin.confirm();
 expect(entryDisclosure({},{page:'douyin',name:'entry'},storage).pending()).toBeUndefined();
});
