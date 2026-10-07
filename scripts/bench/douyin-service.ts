// Build an offline probe. Fixtures follow tests/douyin/douyin.test.ts; synthetic
// sizes exercise response bounds. No network, private cookies or stored responses.
import {resolve} from 'node:path';
const arg=(name:string,fallback:string)=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
const out=resolve(arg('out','/tmp/douyin-service.js'));
const framework=resolve(arg('framework','/home/wilf/data/PodJS/podjs-watch'));
const runtime=arg('runtime','quickjs');
const sourceRef=arg('source-ref','');
const result=await Bun.build({entrypoints:[resolve(import.meta.dir,'douyin-service-runner.ts')],outdir:resolve(out,'..'),naming:out.split('/').at(-1),target:runtime==='quickjs'?'browser':'bun',format:'iife',conditions:['browser'],alias:{'@podjs/framework/bytes':resolve(framework,'packages/framework/src/bytes.ts'),'@podjs/framework/services':resolve(framework,'packages/framework/src/services.ts')},minify:false,plugins:[{name:'baseline-production-sources',setup(builder){
 builder.onLoad({filter:/\/(cloud\/types|bili\/(client|portable|html)|douyin\/client)\.ts$/},args=>{
   if(!sourceRef)return;
   if(args.path.endsWith('/bili/html.ts'))return {contents:`export const correspondenceCsrf=(html:string)=>/id=["']1-name["'][^>]*>\\s*([^<\\s]+)\\s*</.exec(html)?.[1];`,loader:'ts'};
   const path=args.path.slice(resolve(import.meta.dir,'../..').length+1);
   const source=Bun.spawnSync(['git','show',`${sourceRef}:${path}`],{cwd:resolve(import.meta.dir,'../..')});
   if(source.exitCode)throw Error(source.stderr.toString());
   return {contents:source.stdout.toString(),loader:'ts'};
 });
}}]});
if(!result.success)throw Error(result.logs.join('\n'));
await Bun.write(out,`globalThis.__benchBaseline=${!!sourceRef};\n${await Bun.file(out).text()}`);
console.log(out);
