import {readFile,writeFile,realpath,chmod} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyWatchConfig,type BiliWatchConfig} from '../../src/bili/watch-api/config.ts';

// Explicit external input, explicit isolated build destination. Never edit the
// shared checkout or print the payload. No appsecret, cookies or tokens accepted.
const source=process.env.BILI_WATCH_BUILD_CONFIG;
const target=process.argv.find(v=>v.startsWith('--project='))?.slice('--project='.length);
if(!source||!target)throw Error('Use BILI_WATCH_BUILD_CONFIG=<private-json> bun scripts/bili-watch/inject-build-config.ts --project=<isolated-copy>');
const checkout=await realpath(resolve(dirname(fileURLToPath(import.meta.url)),'../..'));
const project=await realpath(target);
if(project===checkout||project.startsWith(checkout+'/'))throw Error('Use an isolated project outside this checkout');
const file=resolve(project,'src/bili/watch-api/build-config.ts');
const actual=await realpath(file);
if(!actual.startsWith(project+'/'))throw Error('Build config cannot escape isolated project');
let clean:BiliWatchConfig={};
const input=JSON.parse(await readFile(source,'utf8'));
if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid build config');
if(Object.keys(input).some(k=>!['appkey','mobiApp','platform','device','build','biliWatchApi','webCookieVerified'].includes(k)))throw Error('Unexpected build config field');
applyWatchConfig({get:()=>undefined,set:(_key,value)=>{clean=value as BiliWatchConfig;}},input);
if(![clean.appkey,clean.mobiApp,clean.platform,clean.device,clean.build].every(Boolean))throw Error('All client identifiers required');
await writeFile(file,"import type {BiliWatchConfig} from './config.ts';\nexport const bundledWatchConfig:BiliWatchConfig="+JSON.stringify(clean)+';\n',{mode:0o600});
await chmod(file,0o600);
console.log('Watch client configuration injected into isolated project; values omitted.');
