import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {existsSync} from 'node:fs';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
const fixture=resolve(import.meta.dir,'fixtures/upstream-u9'),app=resolve(import.meta.dir,'../src');
plugin({name:'upstream-u9-oracle',setup(b){b.onLoad({filter:/upstream-u9\/.*\.txt$|\/(StartupGate|startup-overlay)\.tsx$/},async args=>{
 let source=await Bun.file(args.path).text();const frozen=args.path.startsWith(fixture),isTSX=args.path.includes('.tsx');
 // Load the original private overlay functions verbatim, without mounting or
 // importing the unrelated onboarding/UI graph. Both sides use the same slice.
 if(args.path.includes('StartupGate.tsx')){
  const imports=source.split('\n').filter(line=>/^import /.test(line)&&['solid-js','framework/components','framework/lifecycle','framework/watch','startup-transition','framework/startup'].some(name=>line.includes(name))).join('\n');
  source=imports+"\nimport {startupMark} from "+JSON.stringify(resolve(app,'core/startup-trace.ts'))+";\n"+source.slice(source.indexOf('function StartupTransition('),source.indexOf('function StartupContent('))+'\nexport {StartupTransition,StartupLoading};';
 }
 if(frozen)source=source.replace(/(from\s*|import\s*)(['"])(\.[^'"]+)\2/g,(_m,prefix,q,name)=>{
  const path=resolve(dirname(args.path),name),match=[path+'.txt',path+'.ts.txt',path+'.tsx.txt'].find(existsSync);
  const target=match??resolve(app,path.slice(fixture.length+1));return prefix+JSON.stringify(target);
 });
 return {contents:transformSync(source,{filename:args.path,babelrc:false,configFile:false,presets:[...(isTSX?[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}]]:[]),[require('@babel/preset-typescript'),{isTSX,allExtensions:true}]]}).code,loader:'js'};
});}});
export async function oracle(name:string):Promise<any>{return import(resolve(fixture,name+'.txt'));}
