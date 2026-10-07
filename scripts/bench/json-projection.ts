import {resolve,dirname} from 'node:path';
const f=process.argv.find(v=>v.startsWith('--framework='))?.slice(12)??'/home/wilf/data/PodJS/podjs-watch.wt-c-k21';
const out=process.argv.find(v=>v.startsWith('--out='))?.slice(6)??'/tmp/json-projection.js';
const alias:Record<string,string>={};for(const[key,file]of Object.entries((await Bun.file(resolve(f,'packages/framework/package.json')).json()).exports)as[string,string][]){if(key.startsWith('./'))alias['@podjs/framework/'+key.slice(2)]=resolve(f,'packages/framework',file);}
const r=await Bun.build({entrypoints:[resolve(import.meta.dir,'json-projection-runner.ts')],target:'browser',format:'iife',alias,outdir:dirname(out),naming:out.split('/').at(-1)});if(!r.success)throw Error(r.logs.join('\n'));console.log(out);
