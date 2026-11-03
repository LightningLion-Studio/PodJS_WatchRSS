import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

// Register test.skip when absent; keep independent local assertions separate.
export function externalFixture(env:'ANDROID_WATCHRSS_ROOT'|'PODJS_SYNC_VECTORS_DIR',relative:string):string|undefined {
 const fallback=env==='ANDROID_WATCHRSS_ROOT'?'../../../Android_WatchRSS':'../../../.codex-tmp/cloud-v2/vectors';
 const root=process.env[env]??resolve(import.meta.dir,fallback);
 const path=resolve(root,relative);
 if(existsSync(path))return path;
 console.warn(`[external-fixture SKIP] Missing ${path}; set ${env} to the fixture directory. Local contract tests still run.`);
 return undefined;
}
