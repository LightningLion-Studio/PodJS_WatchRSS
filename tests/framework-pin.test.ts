import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const linker=readFileSync(new URL('../scripts/link-framework.ts',import.meta.url),'utf8');
function invoke(root:string,check=false){
 return Bun.spawnSync([process.execPath,join(root,'scripts/link-framework.ts'),...(check?['--check']:[])],{stdout:'pipe',stderr:'pipe'});
}

function fixture(run:(root:string,framework:string,pocket:string)=>void){
 const root=mkdtempSync(join(tmpdir(),'wrss-framework-pin-')),framework=join(root,'framework'),pocket=join(framework,'vendor/pocketjs');
 const json=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value));
 const git=(dir:string,...args:string[])=>{
  const result=Bun.spawnSync(['git','-C',dir,...args],{stdout:'pipe',stderr:'pipe'});
  if(result.exitCode!==0)throw Error(result.stderr.toString());return result.stdout.toString().trim();
 };
 try{
  mkdirSync(join(root,'scripts'));writeFileSync(join(root,'scripts/link-framework.ts'),linker);
  mkdirSync(join(framework,'packages/framework'),{recursive:true});mkdirSync(pocket,{recursive:true});
  json(join(framework,'packages/framework/package.json'),{name:'@podjs/framework'});json(join(pocket,'package.json'),{name:'@pocketjs/framework'});
  for(const dir of [pocket,framework]){git(dir,'init','-q');git(dir,'add',dir===pocket?'package.json':'packages');git(dir,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Fixture');}
  json(join(root,'framework.lock.json'),{path:framework,revision:git(framework,'rev-parse','HEAD'),pocketjsRevision:git(pocket,'rev-parse','HEAD'),requiresLocalChanges:false});
  json(join(root,'package.json'),{dependencies:{'@podjs/framework':`file:${framework}/packages/framework`,'@pocketjs/framework':`file:${pocket}`}});
  run(root,framework,pocket);
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('locked framework sources link and pass the read-only preflight',()=>fixture((root,framework)=>{
 expect(invoke(root).exitCode).toBe(0);expect(realpathSync(join(root,'node_modules/@podjs/framework'))).toBe(join(framework,'packages/framework'));expect(invoke(root,true).exitCode).toBe(0);
}));
test('a changed framework HEAD fails before installing any package link',()=>fixture((root,framework)=>{
 const commit=Bun.spawnSync(['git','-C',framework,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Drift']);expect(commit.exitCode).toBe(0);
 const result=invoke(root);expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain('Framework revision mismatch');expect(existsSync(join(root,'node_modules'))).toBe(false);
}));
test('a changed PocketJS source fails before installing any package link',()=>fixture((root,_framework,pocket)=>{
 writeFileSync(join(pocket,'package.json'),'{}');const result=invoke(root);expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain('tracked local changes');expect(existsSync(join(root,'node_modules'))).toBe(false);
}));
test('the typecheck preflight rejects an installed dependency from another checkout',()=>fixture((root,framework)=>{
 expect(invoke(root).exitCode).toBe(0);const target=join(root,'node_modules/@podjs/framework');rmSync(target);symlinkSync(framework,target,'dir');
 const result=invoke(root,true);expect(result.exitCode).not.toBe(0);expect(result.stderr.toString()).toContain('Framework link mismatch');expect(realpathSync(target)).toBe(framework);
}));
