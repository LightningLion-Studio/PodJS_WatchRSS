import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

const defaults={
 ANDROID_WATCHRSS_ROOT:'../../../Android_WatchRSS',
 PODJS_SYNC_VECTORS_DIR:'../../../.codex-tmp/cloud-v2/vectors',
 WATCHRSS_WECHAT_ROOT:'../../../WatchRSS_WeChat',
} as const;

// Register test.skip when absent; keep independent local assertions separate.
export function externalFixture(env:keyof typeof defaults,relative:string):string|undefined {
 const root=process.env[env]??resolve(import.meta.dir,defaults[env]);
 const path=resolve(root,relative);
 if(existsSync(path))return path;
 console.warn(`[external-fixture SKIP] Missing ${path}; set ${env} to the fixture directory. Local contract tests still run.`);
 return undefined;
}
