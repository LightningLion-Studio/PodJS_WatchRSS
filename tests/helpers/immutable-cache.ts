import {createHash} from 'node:crypto';
import {appendFileSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
const root=resolve(import.meta.dir,'../..');
const cache=join(root,'.cache/test-gate/fixtures');
const record=(kind:string,start:number,hit:boolean)=>{if(process.env.PODJS_TIMING_FILE)appendFileSync(process.env.PODJS_TIMING_FILE,JSON.stringify({phase:'setup',tool:'fixture',kind,cache_hit:hit,seconds:(performance.now()-start)/1000,command:process.env.PODJS_COMMAND_NAME})+'\n');};
const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
/** All owned implementation, fixture, config and dependency inputs participate.
 * Fresh-schema/encoder tests keep calling their product entry directly. */
export function fixtureInputs(extraRoots:string[]=[]):string {
 const h=createHash('sha256');h.update(Bun.version);
 const walk=(path:string)=>{if(!existsSync(path))return;if(!statSync(path).isDirectory()){h.update(path);h.update(readFileSync(path));return;}for(const entry of readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=join(path,entry.name);if(['node_modules','build','dist','.cache','.git','__pycache__'].includes(entry.name))continue;if(entry.isDirectory())walk(p);else if(entry.isFile()){h.update(p);h.update(readFileSync(p));}}};
 for(const path of [join(root,'src'),join(root,'tests'),...extraRoots])walk(path);
 for(const file of ['package.json','bun.lock','framework.lock.json','tsconfig.json','bunfig.toml'])if(existsSync(join(root,file)))h.update(readFileSync(join(root,file)));
 return h.digest('hex');
}
export function immutableText(recipe:unknown,build:()=>string):string {
 const begin=performance.now();let hit=false;try{
 mkdirSync(cache,{recursive:true});const key=digest(JSON.stringify(recipe)),index=join(cache,key+'.json');
 if(process.env.PODJS_TEST_FRESH!=='1'&&existsSync(index)){const meta=JSON.parse(readFileSync(index,'utf8'));const value=readFileSync(join(cache,meta.sha256));if(digest(value)===meta.sha256){hit=true;return value.toString('utf16le');}throw Error('text fixture cache integrity failure');}
 const text=build(),bytes=Buffer.from(text,'utf16le'),sha256=digest(bytes),temp=mkdtempSync(join(cache,'.text-'));try{writeFileSync(join(temp,'bytes'),bytes);writeFileSync(join(temp,'index'),JSON.stringify({sha256}));renameSync(join(temp,'bytes'),join(cache,sha256));renameSync(join(temp,'index'),index);}finally{rmSync(temp,{recursive:true,force:true});}return text;
 }finally{record('text',begin,hit);}
}
/** Return private bytes for immutable inputs or schema seeds, never action results. */
export async function immutableBytes(recipe:unknown,build:()=>Uint8Array|Promise<Uint8Array>):Promise<Uint8Array> {
 const begin=performance.now();let hit=false;try{
 mkdirSync(cache,{recursive:true});
 const key=digest(JSON.stringify(recipe)),index=join(cache,key+'.json');
 if(process.env.PODJS_TEST_FRESH!=='1'&&existsSync(index)){
  const meta=JSON.parse(readFileSync(index,'utf8')),bytes=readFileSync(join(cache,meta.sha256+'.bin'));
  if(digest(bytes)!==meta.sha256)throw Error('immutable fixture cache integrity failure');
  hit=true;return new Uint8Array(bytes);
 }
 const bytes=await build(),sha256=digest(bytes),temp=mkdtempSync(join(cache,'.build-'));
 try{writeFileSync(join(temp,'bytes'),bytes);writeFileSync(join(temp,'index'),JSON.stringify({sha256}));renameSync(join(temp,'bytes'),join(cache,sha256+'.bin'));renameSync(join(temp,'index'),index);}finally{rmSync(temp,{recursive:true,force:true});}
 return new Uint8Array(bytes);
 }finally{record('bytes',begin,hit);}
}
export async function copyImmutableFile(destination:string,recipe:unknown,build:()=>Promise<Uint8Array>):Promise<void>{
 const bytes=await immutableBytes(recipe,build);writeFileSync(destination,bytes);
}
export async function cachedBackground(entries:Record<string,string>,output:string,frameworkRoot:string,build:(entries:Record<string,string>,output:string)=>Promise<Record<string,{file:string;sha256:string;bytes:number}>>){
 const begin=performance.now();let hit=false;try{
 if(Object.values(entries).some(entry=>relative(root,entry).startsWith('..'))){return await build(entries,output);}
 const inputs=fixtureInputs([...Object.values(entries),join(frameworkRoot,'packages'),join(frameworkRoot,'vendor/pocketjs/framework'),join(frameworkRoot,'bun.lock'),join(frameworkRoot,'package.json'),join(frameworkRoot,'vendor/pocketjs/bun.lock')]);
 const key=digest(JSON.stringify({kind:'background-bundle-v1',inputs,entries,env:{NODE_ENV:process.env.NODE_ENV??null,BUN_CONDITIONS:process.env.BUN_CONDITIONS??null,BUN_OPTIONS:process.env.BUN_OPTIONS??null,NODE_OPTIONS:process.env.NODE_OPTIONS??null}})),directory=join(cache,key);
 hit=process.env.PODJS_TEST_FRESH!=='1'&&existsSync(join(directory,'artifacts.json'));
 if(!hit){
  mkdirSync(cache,{recursive:true});const temp=mkdtempSync(join(cache,'.bundle-'));
  try{const artifacts=await build(entries,temp);writeFileSync(join(temp,'artifacts.json'),JSON.stringify(artifacts));
   if(process.env.PODJS_TEST_FRESH==='1')rmSync(directory,{recursive:true,force:true});
   try{renameSync(temp,directory);}catch(error){if(!existsSync(join(directory,'artifacts.json')))throw error;}
  }finally{rmSync(temp,{recursive:true,force:true});}
 }
 const artifacts=JSON.parse(readFileSync(join(directory,'artifacts.json'),'utf8'));
 for(const artifact of Object.values(artifacts) as {file:string;sha256:string}[]){const source=join(directory,artifact.file);if(digest(readFileSync(source))!==artifact.sha256)throw Error('background fixture cache integrity failure');mkdirSync(dirname(join(output,artifact.file)),{recursive:true});copyFileSync(source,join(output,artifact.file));}
 return artifacts as Record<string,{file:string;sha256:string;bytes:number}>;
 }finally{record('background',begin,hit);}
}
