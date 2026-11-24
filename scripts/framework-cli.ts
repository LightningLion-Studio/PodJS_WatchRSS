import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {assertReleaseDisclosure} from './ai-disclosure-release.ts';
const args=process.argv.slice(2);
const root=resolve(import.meta.dir,'..');
if (args.includes('--release') || args.includes('--production')) {
 try {
  assertReleaseDisclosure(readFileSync(resolve(root,'src/llm/ai-disclosure-default.json'),'utf8'));
 } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
 }
}
const lock=JSON.parse(readFileSync(resolve(root,'framework.lock.json'),'utf8'));
const child=Bun.spawn(['bun',resolve(root,lock.path,'packages/cli/src/cli.ts'),...args,'--target=android-watch','--project='+root],{cwd:root,stdin:'inherit',stdout:'inherit',stderr:'inherit'});
process.exit(await child.exited);
