import {expect,test} from 'bun:test';
// Fresh processes exercise production constructor defaults without polluting global debug gates.
for(const debug of [false,true])test(`default TTS store debug=${debug}: gated fields, secure key and roundtrip`,()=>{
 const code=`
 import {mock} from 'bun:test';
 import assert from 'node:assert/strict';
 const values=new Map(),secrets=new Map();
 mock.module('@podjs/framework/watch',()=>({kv:{get:key=>values.get(key),set:(key,value)=>values.set(key,value)}}));
 mock.module('@podjs/framework/services',()=>({secureStorage:{get:async key=>secrets.get(key),set:async(key,value)=>{secrets.set(key,value);}}}));
 mock.module('../src/debug/host.ts',()=>({debugGate:{require(){if(!${debug})throw Error('disabled');}}}));
 const {TtsConfigStore}=await import('../src/tts/config-store.ts');
 const store=new TtsConfigStore();
 assert.equal(store.read().engine,'local');
 if(!${debug}){assert.throws(()=>store.updateDebugField('model','x'));await assert.rejects(store.setDebugApiKey('minimax','fixture'));assert.equal(values.size,0);assert.equal(secrets.size,0);}
 else {
 store.selectDebugEngine('minimax',{model:'',voiceId:'',baseUrl:''});
 store.updateDebugField('model','speech-2.8-hd');store.updateDebugField('voiceId','voice');store.updateDebugField('baseUrl','https://example.test');
 await store.setDebugApiKey('minimax','fixture-key');assert.equal((await store.publicConfig()).apiKey,'****-key');
 assert.equal(new TtsConfigStore().read().voiceId,'voice');assert(!JSON.stringify([...values]).includes('fixture-key'));
 await store.setDebugApiKey('minimax','');assert.equal(await store.apiKey('minimax'),'');
 }
 `;
 const result=Bun.spawnSync([Bun.which('bun')!,'--eval',code],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'});
 expect(result.exitCode,result.stderr.toString()).toBe(0);
});
