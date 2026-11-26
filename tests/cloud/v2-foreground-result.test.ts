import {expect, test} from 'bun:test';
import {WatchCloudSyncService} from '../../src/cloud/service';
import {cloudSyncView} from '../../src/ui/cloud-sync-view';
import {crypto, enabled} from './k2-crypto';
import {fixture} from './service-fixture';

async function setup(syncV2: () => Promise<void | {completionError:string|null} | null>, announced = true, online = true) {
 const f = await fixture();
 const bootstrap = f.client.bootstrap.bind(f.client);
 if (announced) f.client.bootstrap = async () => ({
  ...await bootstrap(),
  syncV2: {algorithm:'ES256',receiptKeyId:'a'.repeat(32),receiptSigningPublicKey:'fixture'},
 });
 let leased = false;
 const ports = {
  primaryV2:true, keysReady:async () => {},
  syncV2:async () => {
   expect(leased).toBe(false);
   const result = await syncV2();
   return result === undefined ? {completionError:null} : result;
  },
  open:async () => f.session,
  network:async () => ({...f.network,active:online,validated:online}),
  hash:crypto.sha256, uuid:async () => 'unused', now:() => 10_000,
  exclusive:async <T>(work: () => Promise<T>) => {
   leased = true;
   try { return await work(); } finally { leased = false; }
  },
 };
 return new WatchCloudSyncService(ports,enabled);
}

test('v2 preparation never completes the round before actual v2 work settles', async () => {
 let entered!: () => void, finish!: () => void;
 const started = new Promise<void>(resolve => { entered = resolve; });
 const pending = new Promise<void>(resolve => { finish = resolve; });
 const service = await setup(async () => { entered(); await pending; });
 const run = service.syncNowResult(true);
 const startedBeforeResult = await Promise.race([started.then(() => true),run.then(() => false)]);
 try {
  expect(startedBeforeResult).toBe(true);
  expect(service.status.phase).toBe('registering');
  expect(service.status.lastCompletedAt).toBe(0);
 } finally {
  finish();
 }
 expect(await run).toMatchObject({ok:true});
 expect(service.status).toMatchObject({phase:'complete',lastCompletedAt:10_000});
});

test.each([
 ['object_missing','云端资料暂缺，\n请稍后重试'],
 ['network_timeout','连接云端超时，\n请重试'],
 ['cloud_v2_start_unavailable','云同步未能启动，\n请重试'],
 ['unexpected_fixture_failure','云同步未能完成，\n请重试'],
])('v2 start failure %s reaches a retryable reason and the next round can succeed', async (code, detail) => {
 let fails = true;
 const service = await setup(async () => {
  if (!fails) return;
  if (code === 'cloud_v2_start_unavailable') return null;
  throw Object.assign(new Error(code),{code});
 });
 expect(await service.syncNowResult(true)).toMatchObject({ok:false,retryable:true});
 expect(service.status).toMatchObject({phase:'error',lastCompletedAt:0});
 const status = {cloud:service.status,refreshTokenStatus:'valid'} as Parameters<typeof cloudSyncView>[0];
 const view = cloudSyncView(status,true,false,10_000,'waiting');
 expect(view.title).toBe('同步失败');
 expect(view.detail).toBe(detail);
 expect(view.button).toMatchObject({label:'重试',enabled:true});
 fails = false;
 expect(await service.syncNow()).toBe(true);
 expect(service.status.phase).toBe('complete');
});

test.each([
 ['choice_pending','需要选择','查看并选择','请选择要保留的资料'],
 ['cloud_v2_read_only','已暂停上传',undefined,'云端当前只读，\n本机修改已保留'],
 ['body_channel_write_disabled','已暂停上传',undefined,'正文上传暂未开放，\n本机正文已保留'],
 ['body_channel_waiting_wifi','等待 Wi-Fi','立即同步','正文等待 Wi-Fi，\n也可手动同步'],
 ['cloud_v2_pending','还有资料待同步','立即同步','还有资料待同步'],
 ['cloud_v2_repo_missing','需要先同步',undefined,'请先在手机或小程序\n完成首次云同步'],
 ['feature_disabled','暂未开放',undefined,'云同步暂未开放，\n开放后自动同步'],
])('incomplete v2 round %s shows attention and does not publish success', async (code,title,button,detail) => {
 let completionError:string|null=code;
 const service = await setup(async () => ({completionError}));
 expect(await service.syncNow()).toBe(false);
 expect(service.status).toMatchObject({phase:'idle',v2Attention:code,lastCompletedAt:0});
 const status = {cloud:service.status,refreshTokenStatus:'valid'} as Parameters<typeof cloudSyncView>[0];
 const view = cloudSyncView(status,true,false,10_000,'waiting');
 expect(view).toMatchObject({title,detail,tone:'attention'});
 expect(view.button?.label).toBe(button);
 if (code==='choice_pending') expect(view.button?.action).toBe('choice');
 completionError = null;
 expect(await service.syncNow()).toBe(true);
 expect(service.status.lastCompletedAt).toBe(10_000);
 expect(service.status.v2Attention).toBeUndefined();
 expect(cloudSyncView({...status!,cloud:service.status},true,false,10_000)).toMatchObject({
  title:'已同步',detail:'手表与云端已一致',
 });
});

test('missing announcement ends this round with a reason and a finite retry', async () => {
 const service = await setup(async () => { throw Error('must not open v2'); },false);
 const outcome = await service.syncNowResult(true);
 expect(outcome).toMatchObject({ok:false,retryable:true,retryAtMillis:40_000});
 expect(service.status).toMatchObject({phase:'error',message:'云同步暂不可用，\n请稍后重试'});
});

test('known offline ends this v2 attempt without waiting on a request', async () => {
 const service = await setup(async () => { throw Error('must not open v2'); },true,false);
 expect(await service.syncNowResult(true)).toMatchObject({ok:false,networkFailure:true,retryable:true});
 expect(service.status).toMatchObject({phase:'error',message:'未连接网络，\n请联网后重试'});
});

test.each(['projection_preparing','first_follow_pending'])('v2 %s schedules a continuation without marking the round complete',async code=>{
 const service=await setup(async()=>{throw Error(code);});
 expect(await service.syncNowResult()).toMatchObject({ok:false,retryable:true,retryAtMillis:11_000});
 expect(service.status).toMatchObject({phase:'idle',v2Attention:'cloud_v2_pending',lastCompletedAt:0});
});
