import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
test('T32 removes app launch overlay while preserving startup destination rendering',()=>{
 const source=readFileSync(new URL('../src/ui/StartupGate.tsx',import.meta.url),'utf8');
 expect(source).toContain("from '@podjs/framework/splash'");expect(source).toContain('splash.hold(splashOwner)');expect(source).toContain('splash.release(splashOwner)');
 expect(source).toContain("destination()!=='content'||contentReady()");expect(source).toContain('afterFirstScreen(1500)');expect(source).toContain('StartupContent render={props.content}');expect(source).toContain('OnboardingHost onExit=');expect(source).toContain('StartupFailure message=');
 expect(source).not.toContain('StartupLoading');expect(source).not.toContain('startupExitFrame');
});
