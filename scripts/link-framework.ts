// Bun's file: install copies a snapshot. Link the package roots so relative SDK
// imports, exports and newly added files always use the same source tree.
import {existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync} from 'node:fs';
import {dirname, resolve} from 'node:path';

export function linkFramework(root:string,check=false):void {
const app=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
const lock=JSON.parse(readFileSync(resolve(root,'framework.lock.json'),'utf8'));
const framework=realpathSync(resolve(root,lock.path));
const git=(directory:string,...args:string[])=>{
 const result=Bun.spawnSync(['git','-C',directory,...args],{stdout:'pipe',stderr:'pipe'});
 if(result.exitCode!==0)throw Error(`Cannot verify framework source at ${directory}: ${result.stderr.toString().trim()}`);
 return result.stdout.toString().trim();
};
for(const [directory,revision] of [[framework,lock.revision],[resolve(framework,'vendor/pocketjs'),lock.pocketjsRevision]]){
 const actual=git(directory,'rev-parse','HEAD');
 if(actual!==revision)throw Error(`Framework revision mismatch at ${directory}: expected ${revision}, found ${actual}. Check out the locked revision before installing or checking types.`);
 if(!lock.requiresLocalChanges&&git(directory,'status','--porcelain','--untracked-files=no'))throw Error(`Framework has tracked local changes at ${directory}`);
}
// Validate both sources before changing either link. A mutable worktree must
// never silently substitute another revision for framework.lock.json.
const links=[];
for(const name of ['@pocketjs/framework','@podjs/framework']){
 const spec=app.dependencies[name];
 if(!spec?.startsWith('file:'))throw Error(`Expected file: dependency for ${name}`);
 const source=realpathSync(resolve(root,spec.slice(5)));
 const expected=realpathSync(resolve(framework,name==='@podjs/framework'?'packages/framework':'vendor/pocketjs'));
 if(source!==expected)throw Error(`Framework path mismatch for ${name}: expected ${expected}, found ${source}`);
 if(JSON.parse(readFileSync(resolve(source,'package.json'),'utf8')).name!==name)throw Error(`Wrong package at ${source}`);
 const target=resolve(root,'node_modules',name);
 links.push({name,source,target});
}
for(const {name,source,target} of links){
 if(existsSync(target)&&realpathSync(target)===source)continue;
 if(check)throw Error(`Framework link mismatch for ${name}. Run bun install with the locked framework checkout.`);
 mkdirSync(dirname(target),{recursive:true});rmSync(target,{recursive:true,force:true});
 symlinkSync(source,target,'dir');console.log(`Linked ${name} -> ${source}`);
}
}
if(import.meta.main)linkFramework(resolve(import.meta.dir,'..'),process.argv.includes('--check'));
