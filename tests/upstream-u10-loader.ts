import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {existsSync} from 'node:fs';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
const fixture=resolve(import.meta.dir,'fixtures/upstream-u10'),app=resolve(import.meta.dir,'../src');
plugin({name:'upstream-u10-oracle',setup(b){b.onLoad({filter:/upstream-u10\/.*\.txt$/},async args=>{
 let source=await Bun.file(args.path).text();
 source=source.replace(/(from\s*|import\s*)(['"])(\.[^'"]+)\2/g,(_m,prefix,q,name)=>{
  const path=resolve(dirname(args.path),name),match=[path+'.txt',path+'.ts.txt'].find(existsSync);
  return prefix+JSON.stringify(match??resolve(app,path.slice(fixture.length+1)));
 });
 return {contents:transformSync(source,{filename:args.path,babelrc:false,configFile:false,presets:[[require('@babel/preset-typescript'),{allExtensions:true}]]}).code,loader:'js'};
});}});
export async function oracle(name:string):Promise<any>{return import(resolve(fixture,name+'.txt'));}
