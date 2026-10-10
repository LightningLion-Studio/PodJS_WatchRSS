import {mkdtempSync,mkdirSync,copyFileSync,existsSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve} from 'node:path';

/** Apply app permission policy without modifying a host checkout or global init.d. */
export function withAndroidBuildPolicy<T>(run:(env:NodeJS.ProcessEnv)=>T):T {
 const home=mkdtempSync(join(tmpdir(),'watchrss-gradle-'));
 const original=resolve(process.env.GRADLE_USER_HOME??join(homedir(),'.gradle'));
 try {
  mkdirSync(join(home,'init.d'));
  copyFileSync(new URL('./no-record-audio.gradle',import.meta.url),join(home,'init.d/watchrss-permissions.gradle'));
  // Reuse cached dependencies/wrapper; init.d and daemon state stay isolated.
  for(const name of ['caches','wrapper','jdks'])if(existsSync(join(original,name)))symlinkSync(join(original,name),join(home,name),'dir');
  return run({...process.env,GRADLE_USER_HOME:home});
 } finally {rmSync(home,{recursive:true,force:true});}
}
