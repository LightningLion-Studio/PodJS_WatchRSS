import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
const arg=(key:string,fallback:string)=>process.argv.find(v=>v.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
if(arg('runtime','quickjs')!=='quickjs')throw Error('QuickJS required');
const framework=resolve(arg('framework','/home/wilf/data/PodJS/podjs-watch.wt-minor-rs1')),pocket=resolve(framework,'vendor/pocketjs');
const req=createRequire(resolve(pocket,'package.json')), {transformSync}=req('@babel/core');
const out=resolve(arg('out','/tmp/rs1-note.js'));
const aliases:Record<string,string>={'@podjs/framework':resolve(framework,'packages/framework/src/index.ts'),'solid-js':resolve(pocket,'node_modules/solid-js/dist/solid.js')};
const pkg=await Bun.file(resolve(pocket,'package.json')).json();
for(const [key,v] of Object.entries(pkg.exports) as [string,any][]){const file=typeof v==='string'?v:v.import??v.default;if(key.startsWith('./'))aliases['@pocketjs/framework/'+key.slice(2)]=resolve(pocket,file);}
for(const [key,v] of Object.entries((await Bun.file(resolve(framework,'packages/framework/package.json')).json()).exports) as [string,string][]){if(key.startsWith('./'))aliases['@podjs/framework/'+key.slice(2)]=resolve(framework,'packages/framework',v);}
const result=await Bun.build({entrypoints:[resolve(import.meta.dir,'note-reader-runner.ts')],target:'browser',format:'iife',conditions:['browser'],alias:aliases,outdir:dirname(out),naming:out.split('/').at(-1),plugins:[{name:'production-solid',setup(b){b.onLoad({filter:/\.tsx$/},async({path})=>({loader:'js',contents:transformSync(await Bun.file(path).text(),{filename:path,babelrc:false,configFile:false,presets:[[req('@babel/preset-typescript'),{isTSX:true,allExtensions:true}],[req('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}]]}).code}));}}]});
if(!result.success)throw Error(result.logs.join('\n'));
const note=await Bun.file(arg('note','/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/wrss-minor-rs1-readme.md')).text();
await Bun.write(out,`globalThis.console={log(){},warn(){},error(){},info(){},debug(){}};globalThis.__rs1Note=${JSON.stringify(note)};\n`+await Bun.file(out).text());console.log(out);
