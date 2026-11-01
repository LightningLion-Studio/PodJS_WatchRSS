import {afterEach,expect,test} from 'bun:test';
import {douyinBench} from '../../src/douyin/bench.ts';
const before=(globalThis as any).pod;
afterEach(()=>{(globalThis as any).pod=before;});
function fixture(){let seq=100;const calls:any[]=[];(globalThis as any).pod={benchmark:(raw:string)=>{const value=JSON.parse(raw);if(!value.seq)value.seq=++seq;calls.push(value);return value.seq;}};return calls;}
test('login tap records state before/after, preserves auth, and native attempt metadata is shared by persistence',()=>{
 const calls=fixture(),key={},navigate:any[]=[];douyinBench.loginTap(key,()=>false,()=>navigate.push('login'));
 const action=douyinBench.loginEntry(key);douyinBench.persisted(key,action);
 expect(navigate).toEqual(['login']);expect(calls.map(x=>x.code)).toEqual(['auth_state','login_tap','auth_state','login_entry','auth_persisted']);
 expect(new Set(calls.map(x=>x.seq)).size).toBe(1);expect(calls.every(x=>x.attempt===action.attempt)).toBe(true);expect(calls.filter(x=>x.code==='auth_state').map(x=>x.state)).toEqual(['absent','absent']);
 expect(calls.some(x=>x.code==='auth_cleared')).toBe(false);
 const count=calls.length;douyinBench.loginTap(key,()=>undefined,()=>navigate.push('unknown'));expect(calls).toHaveLength(count);expect(navigate).toEqual(['login']);
});
test('retry allocates a fresh seq and attempt; logout feedback is a native presentation request with cancellation',()=>{
 const calls=fixture(),key={},first=douyinBench.loginEntry(key),next=douyinBench.loginEntry(key,true);expect(next.seq).toBeGreaterThan(first.seq);expect(next.attempt).toBeGreaterThan(first.attempt);
 const logout=douyinBench.logoutStart(key);expect(douyinBench.authClear(key)).toEqual({seq:logout});douyinBench.logoutFeedback(key);douyinBench.cancelLogoutFeedback(key);
 expect(calls.at(-2)).toMatchObject({seq:logout,code:'logout_feedback',presented:true});expect(calls.at(-1)).toMatchObject({seq:logout,code:'logout_feedback',cancel_presented:true});
 const entry=douyinBench.entry(key);douyinBench.presentEntry(key,entry,'needs_login');douyinBench.cancelPresented('needs_login',entry);expect(calls.at(-2)).toMatchObject({seq:entry,code:'needs_login',presented:true});
 expect(JSON.stringify(calls)).not.toMatch(/Cookie|https|message|title|mono_ms/);
});
test('unlinked synchronous native bridge emits no fake console or JS clock events',()=>{
 delete (globalThis as any).pod;expect(douyinBench.entry({})).toBe(0);const action=douyinBench.loginEntry({});expect(action.seq).toBe(0);
});

test('auth_persisted is emitted at the authoritative logged-in publication and never for a superseded Cookie write',async()=>{
 const {DouyinClient}=await import('../../src/douyin/client.ts');
 for(const superseded of [false,true]){
  let release!:()=>void;const gate=new Promise<void>(r=>release=r),data=new Map<string,string>(),calls:any[]=[];let seq=1000,client!:InstanceType<typeof DouyinClient>,published='';
  (globalThis as any).pod={benchmark:(raw:string)=>{const value=JSON.parse(raw);if(!value.seq)value.seq=++seq;if(value.code==='auth_persisted')published=client.authState();calls.push(value);return value.seq;}};
  client=new DouyinClient({transport:{request:async()=>{throw Error('unused');}},secureStorage:{get:async k=>data.get(k)??null,set:async(k,v)=>{await gate;data.set(k,v);},remove:async k=>{data.delete(k);}}});
  const action=douyinBench.loginEntry(client),write=client.applyCookie('SYNTHETIC');const logout=superseded?client.logout():undefined;release();await write;await logout;
  const persisted=calls.filter(x=>x.code==='auth_persisted');expect(persisted).toHaveLength(superseded?0:1);
  if(!superseded){expect(published).toBe('logged-in');expect(persisted[0]).toMatchObject({seq:action.seq,attempt:action.attempt});}
 }
});
test('an old logout deletion keeps its original action metadata after a later login tap',async()=>{
 fixture();const {DouyinClient}=await import('../../src/douyin/client.ts');let observed:unknown;const client=new DouyinClient({transport:{request:async()=>{throw Error('unused');}},secureStorage:{get:async()=>null,set:async()=>{},remove:async(_key,metadata)=>{if(metadata)observed=metadata;}}});
 const logout=douyinBench.logoutStart(client),cleanup=client.logout();douyinBench.loginTap(client,()=>false,()=>{});const login=douyinBench.loginEntry(client);await cleanup;
 expect(observed).toEqual({seq:logout});expect(login.seq).not.toBe(logout);
});
