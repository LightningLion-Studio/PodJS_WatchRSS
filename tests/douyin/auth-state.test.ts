import {expect,test} from 'bun:test';
import {DouyinClient} from '../../src/douyin/client.ts';
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const unused={request:async()=>{throw Error('unexpected network');}};
test('unknown is explicit; concurrent state reads share storage and logout wins an older read',async()=>{
 const read=deferred<string|null>(),remove=deferred<void>();let reads=0;
 const client=new DouyinClient({transport:unused,secureStorage:{get:k=>{if(k!=='douyin.cookie')return Promise.resolve(null);reads++;return read.promise;},set:async()=>{},remove:()=>remove.promise}});
 const states:string[]=[];const stop=client.subscribeAuth(s=>states.push(s));
 expect(client.authState()).toBe('unknown');const a=client.isLoggedIn(),b=client.isLoggedIn();expect(reads).toBe(1);
 const logout=client.logout();expect(client.authState()).toBe('logged-out');expect(await client.isLoggedIn()).toBe(false);expect(await client.readCookie()).toBeNull();expect(reads).toBe(1);
 read.resolve('old fixture');remove.resolve();await logout;expect(await a).toBe(false);expect(await b).toBe(false);expect(states).toEqual(['logged-out']);stop();
});
test('new Cookie waits for older cleanup and unknown reads cannot rehydrate the old Cookie',async()=>{
 const cleanup=deferred<void>(),data=new Map([['douyin.cookie','old']]);let clears=0;
 const client=new DouyinClient({transport:unused,onLogout:async()=>{clears++;await cleanup.promise;},secureStorage:{get:async k=>data.get(k)??null,set:async(k,v)=>{data.set(k,v);},remove:async k=>{data.delete(k);}}});
 expect(await client.isLoggedIn()).toBe(true);const logout=client.logout();const apply=client.applyCookie('new fixture');
 expect(client.authState()).toBe('unknown');let settled=false;const during=client.isLoggedIn().then(v=>{settled=true;return v;});
 await Promise.resolve();expect(settled).toBe(false);cleanup.resolve();await logout;await apply;
 expect(await during).toBe(true);expect(client.authState()).toBe('logged-in');expect(data.get('douyin.cookie')).toBe('new fixture');expect(clears).toBe(1);
});
test('cleanup rejection stays visible and does not revive the session or poison a later login',async()=>{
 const data=new Map([['douyin.cookie','old']]);let fail=true;
 const client=new DouyinClient({transport:unused,secureStorage:{get:async k=>data.get(k)??null,set:async(k,v)=>{data.set(k,v);},remove:async k=>{if(fail)throw Error('synthetic remove failed');data.delete(k);}}});
 await expect(client.logout()).rejects.toThrow('synthetic remove failed');expect(client.authState()).toBe('logged-out');expect(await client.readCookie()).toBeNull();
 fail=false;await client.applyCookie('fresh');expect(await client.isLoggedIn()).toBe(true);
});
test('browser cleanup is submitted before slow secure deletion; all cleanup promises settle before new Cookie commits',async()=>{
 const remove=deferred<void>(),browser=deferred<void>();let called=0;
 const client=new DouyinClient({transport:unused,onLogout:()=>{called++;return browser.promise;},secureStorage:{get:async()=>null,set:async()=>{},remove:()=>remove.promise}});
 const logout=client.logout();await Promise.resolve();expect(called).toBe(1);browser.reject(Error('synthetic browser cleanup'));remove.resolve();await expect(logout).rejects.toThrow('synthetic browser cleanup');
});
