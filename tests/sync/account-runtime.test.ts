import {test,expect} from 'bun:test';

test('syncAccount writes through the actual LLM singleton secureStorage adapter before returning identity',()=>{
 const result=Bun.spawnSync(['bun','--eval',`
  import {mock} from 'bun:test';
  import {strict as assert} from 'node:assert';
  const values=new Map();let writes=0,release;
  const committed=new Promise(resolve=>release=resolve);
  mock.module('@podjs/framework/services',()=>({
   secureStorage:{get:async key=>values.get(key),set:async(key,value)=>{writes++;await committed;values.set(key,value);},delete:async key=>values.delete(key)},
   uri:{parse:async value=>{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname};}},
   hostOperation(){throw Error('unexpected network');},fileChunks:{},
   bytesToBase64:b=>Buffer.from(b).toString('base64'),base64ToBytes:s=>new Uint8Array(Buffer.from(s,'base64'))
  }));
  const {summaryAccountStore}=await import('./src/llm/runtime.ts');
  const {createApplicationActionHandler}=await import('./src/sync/application-actions.ts');
  const fixture=(await import('./tests/fixtures/account-debug-phone.json')).default;
  const handler=createApplicationActionHandler({notes:{},deviceId:async()=>'watch',notesChanged(){},accountStore:summaryAccountStore});
  let resolved=false,notified=0;summaryAccountStore.subscribe(()=>notified++);
  const task=handler(fixture.cases[0].frames[3]).then(reply=>{resolved=true;return reply;});
  for(let i=0;i<10;i++)await Promise.resolve();
  assert.equal(writes,1);assert.equal(resolved,false);assert.equal(notified,0);assert.equal(await summaryAccountStore.read(),null);
  release();const reply=await task;
  assert.equal(reply.boundUserId,'user-1');assert.equal(notified,1);assert.equal(values.size,1);assert.ok(values.has('state_json'));
  const account=await summaryAccountStore.read();assert.equal(account.watchDeviceToken,'fixture-access');assert.equal(account.watchRefreshToken,'fixture-refresh');
  await summaryAccountStore.clear();assert.equal(await summaryAccountStore.read(),null);
 `],{cwd:new URL('../..',import.meta.url).pathname,stdout:'pipe',stderr:'pipe'});
 expect(result.stderr.toString()).toBe('');expect(result.exitCode).toBe(0);
});
