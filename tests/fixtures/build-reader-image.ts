// Production Solid compiler, renderer and loader; only host services are fixtures.
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {realpathSync} from 'node:fs';
const app=resolve(import.meta.dir,'../..');
const framework=resolve(dirname(realpathSync(Bun.resolveSync('@podjs/framework/image',app))),'../../..');
const pocket=resolve(framework,'vendor/pocketjs');
const require=createRequire(resolve(pocket,'package.json'));
const {transformSync}=require('@babel/core');
const {solidConditionalProps}=await import(resolve(pocket,'framework/compiler/solid-props.ts'));
const aliases:Record<string,string>={'solid-js':resolve(pocket,'node_modules/solid-js/dist/solid.js'),'solid-js/universal':resolve(pocket,'node_modules/solid-js/universal/dist/universal.js')};
for(const [name,root] of [['@pocketjs/framework',pocket],['@podjs/framework',resolve(framework,'packages/framework')]]){
 const pkg=await Bun.file(resolve(root,'package.json')).json();
 for(const [key,value] of Object.entries(pkg.exports) as [string,any][]){const file=typeof value==='string'?value:value.import??value.default;if(typeof file==='string')aliases[name+(key==='.'?'':key.slice(1))]=resolve(root,file);}
}
aliases['@test/spec']=resolve(pocket,'contracts/spec/spec.ts');
const baseline=process.env.WRSS_IMAGE_BASELINE==='1';
const result=await Bun.build({entrypoints:[resolve(import.meta.dir,'reader-image-runner.ts')],outdir:process.argv[2],naming:'reader-image.js',target:'bun',conditions:['browser'],plugins:[{name:'production-reader-image',setup(builder){
 builder.onResolve({filter:/.*/},args=>{
  if(process.env.READERPERF_PAGING_OVERLAY&&args.path.endsWith('/ReaderBody.tsx'))return {path:resolve(process.env.READERPERF_PAGING_OVERLAY,'src/ui/ReaderBody.tsx')};
  if(baseline&&args.path.endsWith('/RemoteImage.tsx'))return {path:resolve(import.meta.dir,'RemoteImage-u3-before.tsx')};
  if(aliases[args.path])return {path:realpathSync(aliases[args.path])};
 });
 builder.onLoad({filter:/\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,plugins:[solidConditionalProps],presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));
}}]});
if(!result.success)throw new Error(result.logs.join('\n'));
