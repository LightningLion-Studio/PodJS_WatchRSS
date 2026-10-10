import {expect,test} from 'bun:test';
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {withAndroidBuildPolicy} from '../scripts/android/build-policy.ts';

test('Android permission policy is scoped to one build and cleans up after failure without changing caller environment',()=>{
 const original=process.env.GRADLE_USER_HOME;let home='';
 expect(()=>withAndroidBuildPolicy(env=>{
  home=env.GRADLE_USER_HOME!;expect(home).not.toBe(original);
  const policy=readFileSync(join(home,'init.d/watchrss-permissions.gradle'),'utf8');
  expect(policy).toContain('android.permission.RECORD_AUDIO');expect(policy).toContain('tools:node="remove"');
  expect(process.env.GRADLE_USER_HOME).toBe(original);throw Error('fixture build failure');
 })).toThrow('fixture build failure');
 expect(home.length).toBeGreaterThan(0);expect(existsSync(home)).toBe(false);expect(process.env.GRADLE_USER_HOME).toBe(original);
});

test('package entry forwards release options through CLI, applies policy and cleans failed child state',async()=>{
 const {mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const temp=mkdtempSync(join(tmpdir(),'watchrss-cli-fixture-'));
 try {
  mkdirSync(join(temp,'packages/cli/src'),{recursive:true});
  const output=join(temp,'received.json');
  writeFileSync(join(temp,'packages/cli/src/cli.ts'),`import {writeFileSync,existsSync} from 'node:fs';writeFileSync(process.env.WRSS_FIXTURE_OUTPUT!,JSON.stringify({args:process.argv.slice(2),home:process.env.GRADLE_USER_HOME,policy:existsSync(process.env.GRADLE_USER_HOME+'/init.d/watchrss-permissions.gradle')}));process.exitCode=7;`);
  const entry=new URL('../scripts/android/package.ts',import.meta.url).pathname;
  const child=Bun.spawnSync([Bun.which('bun')!,entry,'--release','--debuggable','--version-code=1011'],{env:{...process.env,WATCHRSS_FRAMEWORK_ROOT:temp,WRSS_FIXTURE_OUTPUT:output},stdout:'pipe',stderr:'pipe'});
  expect(child.exitCode).toBe(7);
  const result=JSON.parse(readFileSync(output,'utf8'));
  expect(result.args).toEqual(['package','--target=android-watch','--project='+new URL('../',import.meta.url).pathname,'--release','--debuggable','--version-code=1011']);
  expect(result.policy).toBe(true);expect(existsSync(result.home)).toBe(false);
 } finally {rmSync(temp,{recursive:true,force:true});}
});
