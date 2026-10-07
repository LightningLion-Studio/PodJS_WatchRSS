import {resolve,dirname} from 'node:path';
const arg=(k:string,d='')=>process.argv.find(v=>v.startsWith(`--${k}=`))?.slice(k.length+3)??d;
const f=arg('framework','/home/wilf/data/PodJS/podjs-watch.wt-c-k21'),out=arg('out','/tmp/refresh-differential.js'),fixture=arg('fixture');if(!fixture)throw Error('--fixture required');
const alias:Record<string,string>={};for(const [key,file]of Object.entries((await Bun.file(resolve(f,'packages/framework/package.json')).json()).exports)as[string,string][]){if(key.startsWith('./'))alias['@podjs/framework/'+key.slice(2)]=resolve(f,'packages/framework',file);}
const r=await Bun.build({entrypoints:[resolve(import.meta.dir,'refresh-differential-runner.ts')],target:'browser',format:'iife',alias,outdir:dirname(out),naming:out.split('/').at(-1)});if(!r.success)throw Error(r.logs.join('\n'));await Bun.write(out,'globalThis.__refreshFixture='+await Bun.file(fixture).text()+';\n'+await Bun.file(out).text());console.log(out);
