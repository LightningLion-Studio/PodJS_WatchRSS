import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {existsSync} from 'node:fs';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
const fixture=resolve(import.meta.dir,'fixtures/upstream-u8'),app=resolve(import.meta.dir,'../src');
plugin({name:'upstream-u8-oracle',setup(b){b.onLoad({filter:/upstream-u8\/.*\.txt$|\/(ReaderTextRow|ScrollEntries|route-activity|variable-list)\.tsx$/},async args=>{
 let source=await Bun.file(args.path).text();const frozen=args.path.startsWith(fixture),isTSX=args.path.includes('.tsx');
 if(frozen)source=source.replace(/(from\s*|import\s*)(['"])(\.[^'"]+)\2/g,(_m,prefix,q,name)=>{
  const path=resolve(dirname(args.path),name),match=[path+'.txt',path+'.ts.txt',path+'.tsx.txt'].find(existsSync);
  const target=match??resolve(app,path.slice(fixture.length+1));return prefix+JSON.stringify(target);
 });
 return {contents:transformSync(source,{filename:args.path,babelrc:false,configFile:false,presets:[...(isTSX?[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}]]:[]),[require('@babel/preset-typescript'),{isTSX,allExtensions:true}]]}).code,loader:'js'};
});}});
export async function oracle(name:string):Promise<any>{return import(resolve(fixture,name+'.txt'));}
