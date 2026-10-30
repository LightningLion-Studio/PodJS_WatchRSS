/** Real headless QuickJS decode differential, synthetic ASCII bytes
 * at 1177 encrypted-record cache size. No services, UI, files/account data in the guest. */
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {buildBackground} from '../../../../PodJS/podjs-watch/packages/cli/src/background-build';
const root=resolve('.codex-tmp/restorefix-window-backoff/utf8'),framework='/home/wilf/data/PodJS/podjs-watch';mkdirSync(root,{recursive:true});
const results:any={bytes:14869335,segmentBytes:1048576,segmentCount:15,kind:'synthetic ASCII bytes matching encrypted-record cache size, independently released pieces to preserve the diagnostic runner 16MiB heap',before:[],after:[]};
for(const mode of ['before','after'] as const){const entry=join(root,mode+'.ts');writeFileSync(entry,`import {decodeUtf8} from ${JSON.stringify(resolve('src/core/utf8-decode.ts'))};export default()=>{${mode==='before'?'delete (globalThis as any).__podByteCodecs;':''}if(typeof (globalThis as any).pod!=='undefined')return 'failure';let total=0;for(let at=0;at<14869335;at+=1048576){const n=Math.min(1048576,14869335-at),bytes=new Uint8Array(n).fill(65),text=decodeUtf8(bytes,'douyin');if(text.length!==n||text.charCodeAt(0)!==65||text.charCodeAt(n-1)!==65)return 'failure';total+=text.length;}return total===14869335?'success':'failure';};`);const artifacts=await buildBackground({decode:entry},join(root,mode)),artifact=artifacts.decode;
 for(let n=0;n<3;n++){const r=Bun.spawnSync(['cargo','run','--quiet','-p','podjs-runtime','--example','background-run','--',join(root,mode,artifact.file),artifact.sha256],{cwd:framework,stdout:'pipe',stderr:'pipe'});if(r.exitCode)throw Error(new TextDecoder().decode(r.stderr)+new TextDecoder().decode(r.stdout));const value=JSON.parse(new TextDecoder().decode(r.stdout).trim());if(value.status!=='success')throw Error('decode mismatch');results[mode].push(value.elapsedMs);}
}
results.ratio=results.before.slice().sort((a:number,b:number)=>a-b)[1]/Math.max(1,results.after.slice().sort((a:number,b:number)=>a-b)[1]);writeFileSync(join(root,'result.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
