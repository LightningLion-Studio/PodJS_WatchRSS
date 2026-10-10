import {expect,test} from 'bun:test';
import {readFileSync,existsSync} from 'node:fs';
import config from '../pod.config.json';
test('WatchRSS delegates black system splash and native 80ms/1.12 exit to the framework',()=>{
 expect(config.android.splash).toEqual({background:'#000000',icon:'@drawable/watchrss_splash_icon',iconBackground:'#000000',exit:{fade:true,scale:1.12,durationMs:80}});
 const gate=readFileSync(new URL('../src/ui/StartupGate.tsx',import.meta.url),'utf8');expect(gate).not.toContain('launch-native');expect(gate).not.toContain('StartupOverlayTransition');expect(existsSync(new URL('../src/ui/startup-transition.ts',import.meta.url))).toBe(false);
});
