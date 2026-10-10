import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {withAndroidBuildPolicy} from './build-policy.ts';
const project=fileURLToPath(new URL('../../',import.meta.url));
const framework=process.env.WATCHRSS_FRAMEWORK_ROOT??JSON.parse(readFileSync(join(project,'framework.lock.json'),'utf8')).path;
const args=process.argv.slice(2);
if(args.some(arg=>/^--(?:target|project)(?:=|$)/.test(arg)))throw Error('This WatchRSS package entry owns the android-watch target and project; pass release/debug/version options only');
withAndroidBuildPolicy(env=>{
 const child=Bun.spawnSync(['bun',join(framework,'packages/cli/src/cli.ts'),'package','--target=android-watch','--project='+project,...args],{env,stdout:'inherit',stderr:'inherit'});
 process.exitCode=child.exitCode;
});
