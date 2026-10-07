import {test,expect} from 'bun:test';
const saved=new Map<string,string>();
(globalThis as any).pod={takeEvents:()=>undefined,kvGet:(key:string)=>saved.get(key),kvSet:(key:string,value:string)=>{saved.set(key,value);return 0;}};
const {SettingsStore}=await import('../src/settings/store.ts');
const {TemporaryOriginalHintStore}=await import('../src/settings/temporary-original-hints.ts');
test('production default stores persist phone setting and imported hint cooldown through host KV',()=>{
 const store=new SettingsStore();expect(store.load().phoneConnectionEnabled).toBe(true);store.update({phoneConnectionEnabled:false});expect(new SettingsStore().load().phoneConnectionEnabled).toBe(false);
 const hint=new TemporaryOriginalHintStore(),now=1700000000000;expect(hint.record(39,now)).toBe(false);expect(hint.record(39,now+1)).toBe(false);expect(hint.record(39,now+2)).toBe(true);expect(new TemporaryOriginalHintStore().record(39,now+3)).toBe(false);
});
