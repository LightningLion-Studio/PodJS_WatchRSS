// Apply only this feature's pinned host extension to the same local dependency
// used by the CLI and application imports. Preserve all other source changes.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
const app=resolve(import.meta.dir,'..');
const lock=JSON.parse(readFileSync(resolve(app,'framework.lock.json'),'utf8'));
const entry=lock.patches?.find((item:{manifest:string})=>item.manifest==='patches/framework/watch-device-info-v1.json');
if(!entry)throw Error('Missing pinned device.info host patch');
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const path=resolve(app,entry.manifest),bytes=readFileSync(path);
if(hash(bytes)!==entry.sha256)throw Error('Device-info patch manifest checksum mismatch');
const manifest=JSON.parse(bytes.toString()),patch=readFileSync(resolve(dirname(path),manifest.patch));
if(hash(patch)!==manifest.sha256)throw Error('Device-info patch checksum mismatch');
const dependency=JSON.parse(readFileSync(resolve(app,'package.json'),'utf8')).dependencies['@podjs/framework'];
if(!dependency?.startsWith('file:'))throw Error('Expected the pinned local PodJS dependency');
const framework=resolve(app,dependency.slice(5),'../..');
const states=manifest.files.map((file:{path:string;beforeSha256:string;afterSha256:string})=>{
 const actual=hash(readFileSync(resolve(framework,file.path)));
 return actual===file.afterSha256?'applied':actual===file.beforeSha256?'base':'different';
});
if(!states.every((state:string)=>state==='applied')){
 if(!states.every((state:string)=>state==='base'))throw Error('Device-info host patch inputs differ; reconcile local changes with the pinned framework before building');
 for(const args of [['apply','--check','-'],['apply','-']]){
  const result=spawnSync('git',args,{cwd:framework,input:patch,encoding:'utf8'});
  if(result.status!==0)throw Error(result.stderr||'Cannot apply device.info host patch');
 }
}
