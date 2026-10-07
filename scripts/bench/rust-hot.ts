// Offline build only. Private HTML is embedded in the temporary bundle, never committed.
import {resolve,dirname} from 'node:path';
const arg=(key:string,fallback:string)=>process.argv.find(v=>v.startsWith(`--${key}=`))?.slice(key.length+3)??fallback;
if(arg('runtime','quickjs')!=='quickjs')throw Error('RS1 requires the runtime rquickjs runner');
const framework=resolve(arg('framework','/home/wilf/data/PodJS/podjs-watch.wt-minor-rs1'));
const out=resolve(arg('out','/tmp/rs1.js'));
const html=await Bun.file(arg('html','/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/k9-profile/article.html')).text();
const result=await Bun.build({entrypoints:[resolve(import.meta.dir,'rust-hot-runner.ts')],target:'browser',format:'iife',outdir:dirname(out),naming:out.split('/').at(-1),alias:{'@podjs/framework/bytes':resolve(framework,'packages/framework/src/bytes.ts')},conditions:['browser']});
if(!result.success)throw Error(result.logs.join('\n'));
await Bun.write(out,`globalThis.__rs1Html=${JSON.stringify(html)};\n`+await Bun.file(out).text());
console.log(out);
