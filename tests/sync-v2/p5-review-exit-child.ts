/** Actual process exit after the immutable queue CAS, before any publish send. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {p5Fixture,dirtyRollback} from './p5-fixture';
import {canonical} from '../../src/sync-v2/protocol';
const f=await p5Fixture({root:process.argv[2]}),requestId='e'.repeat(32);await dirtyRollback(f);f.publisher.flush=async()=>{const s=await f.projection.readState();writeFileSync(join(f.root,'exit.json'),JSON.stringify({requestId,request:canonical(s.cloud.pendingPublish.request),account:f.server.account,device:f.server.device,serverRevision:f.server.serverRevision}));process.exit(77);};await f.control.chooseLocal((await f.control.pendingChoice())!.proof,requestId);throw Error('exit_not_reached');
