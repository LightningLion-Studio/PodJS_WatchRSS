import './apply-watch-device-info.ts';
// Bun's file: install copies a snapshot. Link the package roots so relative SDK
// imports, exports and newly added files always use the same source tree.
import {existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
const root=resolve(import.meta.dir,'..');
const app=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
for(const name of ['@pocketjs/framework','@podjs/framework']){
 const spec=app.dependencies[name];
 if(!spec?.startsWith('file:'))throw Error(`Expected file: dependency for ${name}`);
 const source=realpathSync(resolve(root,spec.slice(5)));
 if(JSON.parse(readFileSync(resolve(source,'package.json'),'utf8')).name!==name)throw Error(`Wrong package at ${source}`);
 const target=resolve(root,'node_modules',name);
 if(existsSync(target)&&realpathSync(target)===source)continue;
 mkdirSync(dirname(target),{recursive:true});rmSync(target,{recursive:true,force:true});
 symlinkSync(source,target,'dir');console.log(`Linked ${name} -> ${source}`);
}
