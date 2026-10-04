import {mount} from '@pocketjs/framework/solid';
import {createSignal, Show} from 'solid-js';
import {getDisplayMetrics, kv} from '@podjs/framework/watch';
import {delay, fileChunks} from '@podjs/framework/services';
import {accountStatusSnapshot} from '../../../src/account/status.ts';
import type {WatchAccountState} from '../../../src/account/types.ts';
import {AccountStatusScreen} from '../../../src/ui/AccountStatusScreen.tsx';

const metrics = getDisplayMetrics(), key = 'account-status-ui-result';
const [stage, setStage] = createSignal<'unbound' | 'bound' | 'expired'>('unbound');
const account: WatchAccountState = {
  userId:'fixture',phoneMasked:'138****1234',installId:'fixture',watchDeviceToken:'fixture-access',
  tokenExpiresAtMillis:500,watchRefreshToken:'fixture-refresh',refreshTokenExpiresAtMillis:1000,
  backendBaseUrl:'',posthogHost:'',posthogProjectApiKey:'',updatedAtMillis:0,
  entitlement:{plan:'member',active:true,expiresAtMillis:0,features:[]},
  telemetryConfig:{anonymousEnabled:true,diagnosticsEnabled:false,sampleRate:1},
};
const load = async () => stage()==='unbound' ? null : accountStatusSnapshot(
  stage()==='expired' ? {...account,entitlement:{...account.entitlement,active:false}} : account,
  stage()==='expired' ? 1000 : 100,
);
function App() {
  return <Show when={stage()} keyed>{name => <AccountStatusScreen width={metrics.logicalWidth}
    height={metrics.logicalHeight} active={()=>true} load={load}
    onError={error=>kv.set(key,{state:'failed',error})} ref={()=>{}} />}</Show>;
}
mount(App);
void (async () => {
  for (const name of ['unbound','bound','expired'] as const) {
    setStage(name);
    await delay(2000).result;
    kv.set(key,{state:'running',stage:name});
    const gate = `account-advance-${name}`;
    const deadline = Date.now()+30000;
    while (!(await fileChunks.stat(gate)).file) {
      if (Date.now()>deadline) throw Error(`Timed out at ${name}`);
      await delay(100).result;
    }
  }
  kv.set(key,{state:'passed',stage:'done'});
})().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
