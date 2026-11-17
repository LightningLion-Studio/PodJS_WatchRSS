import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dir,'..');
const lock=JSON.parse(readFileSync(resolve(root,'framework.lock.json'),'utf8'));
const child=Bun.spawn(['bun',resolve(root,lock.path,'packages/cli/src/cli.ts'),...process.argv.slice(2),'--target=android-watch','--project='+root],{cwd:root,stdin:'inherit',stdout:'inherit',stderr:'inherit'});
process.exit(await child.exited);
