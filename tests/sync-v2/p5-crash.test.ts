import {test,expect} from 'bun:test';
import {cpSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {p5Fixture,dirtyRollback} from './p5-fixture';
import {SqlFixture} from './fixture';
const child=resolve(import.meta.dir,'p5-crash-child.ts');
for(const mode of ['DELETE','WAL'])test('P5 native '+mode+' recovery basis active and editing ACK survive every process-exit edge',async()=>{const f=await p5Fixture();try{
 await dirtyRollback(f);const proof=(await f.control.pendingChoice())!.proof,requestId='f'.repeat(32);f.server.loseChoice=true;await expect(f.control.chooseCloud(proof,requestId)).rejects.toThrow('choice_response_lost');f.db.raw.exec('PRAGMA wal_checkpoint(FULL)');writeFileSync(join(f.root,'audit.json'),JSON.stringify({requestId,response:f.server.requests.get(requestId)}));
 async function run(path:string,edge:string){const p=Bun.spawn([process.execPath,child,path,mode,edge],{stdout:'pipe',stderr:'pipe'}),[code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()]);if(code!==0&&code!==78)throw Error(err);return {code,out};}
 const counted=f.root+'-count';cpSync(f.root,counted,{recursive:true});let count:number;try{count=Number((await run(counted,'count')).out.trim());expect(count).toBeGreaterThan(10);}finally{rmSync(counted,{recursive:true,force:true});}
 for(let edge=0;edge<=count!+1;edge++){const path=f.root+'-edge-'+edge;cpSync(f.root,path,{recursive:true});try{expect((await run(path,String(edge))).code).toBe(78);const db=new SqlFixture(join(path,'state.sqlite'),mode);try{const s=await db.store().readStableState(),title=(await db.query('SELECT title FROM memo_notes'))[0]!.title;if(edge<=count!){expect(title).toBe('offline edit');expect(s.pendingChoice).not.toBeNull();expect(s.recoveryCopies??[]).toHaveLength(0);}else{expect(title).toBe('title n');expect(s.pendingChoice).toBeNull();expect(s.recoveryCopies).toHaveLength(1);expect(s.recoveryPins).toHaveLength(1);expect(s.activeGeneration).toBe(s.account!.oid);expect(s.hasUnsentEdits).toBe(false);expect(s.cloud.pendingApplied).not.toBeNull();}}finally{db.close();}}finally{rmSync(path,{recursive:true,force:true});}}
 }finally{f.close();}},180000);
