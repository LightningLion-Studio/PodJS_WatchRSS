import {expect, test} from 'bun:test';
import {accountStatusSnapshot, type AccountCloudStatus} from '../src/account/status.ts';
import type {WatchAccountState} from '../src/account/types.ts';
import {cloudSyncView, coalescedRequest} from '../src/ui/cloud-sync-view.ts';
import {PROFILE_ENTRIES} from '../src/ui/profile-entries.ts';
import {profileDestination, routeIsKnown} from '../src/ui/routes/meta.ts';
import {telemetryScreen} from '../src/telemetry/screens.ts';

const account: WatchAccountState = {
  userId: 'user-a', phoneMasked: '138****1234', installId: 'i', watchDeviceToken: 't', tokenExpiresAtMillis: 1000,
  watchRefreshToken: 'r', refreshTokenExpiresAtMillis: 2000, backendBaseUrl: 'https://x', posthogHost: '', posthogProjectApiKey: '',
  entitlement: {plan: 'member', active: true, expiresAtMillis: 0, features: []},
  telemetryConfig: {anonymousEnabled: true, diagnosticsEnabled: false, sampleRate: 1}, updatedAtMillis: 0,
};
const cloud = (value: Partial<AccountCloudStatus>): AccountCloudStatus =>
  ({message: '尚未同步', usedBytes: 0, quotaBytes: 0, accountId: 'user-a', ...value});
const view = (state: WatchAccountState | null, status?: AccountCloudStatus, pending = false) =>
  cloudSyncView(accountStatusSnapshot(state, 500, status), status !== undefined, pending, 500);

test('我的 keeps native order and every entry opens its own destination', () => {
  expect(PROFILE_ENTRIES.map(e => e.title)).toEqual(['账号', '云同步', '我的收藏', '稍后再看', '连接手机', '设置', '关于', '联系开发者']);
  expect(PROFILE_ENTRIES.map(e => profileDestination(e.key))).toEqual([
    {page: 'account-status'}, {page: 'cloud-sync'}, {page: 'saved'}, {page: 'watch-later'},
    {page: 'phone-connection'}, {page: 'settings'}, {information: 'about'}, {information: 'contact-developer'},
  ]);
  expect(routeIsKnown('cloud-sync')).toBe(true);
  expect(telemetryScreen({page: 'cloud-sync'})).toBe('CloudSyncActivity');
});

test('cloud page never offers sync without a bound account and a real service', () => {
  expect(cloudSyncView(undefined, true, false).button).toBeUndefined();
  expect(view(account)).toMatchObject({title: '暂未开放'});
  expect(view(account).button).toBeUndefined();
  expect(view(null, cloud({}))).toMatchObject({title: '未登录账号', button: {action: 'phone'}});
  expect(view({...account, entitlement: {...account.entitlement, plan: 'free'}}, cloud({})).button?.action).toBe('sync');
  expect(cloudSyncView(accountStatusSnapshot(account, 2500, cloud({})), true, false, 2500))
    .toMatchObject({title: '登录已过期', button: {action: 'phone'}});
});

test("another account's space, time and phase are not shown", () => {
  const foreign = cloud({accountId: 'user-b', phase: 'complete', usedBytes: 5 << 20, quotaBytes: 1 << 30, lastCompletedAt: 400});
  const snapshot = accountStatusSnapshot(account, 500, foreign)!;
  expect(snapshot.cloud).toEqual({message: '尚未同步', usedBytes: 0, quotaBytes: 0, phase: 'idle'});
  const ui = cloudSyncView(snapshot, true, false, 500);
  expect(ui.title).toBe('尚未同步');
  expect(ui.space).toBeUndefined();
  expect(ui.lastSynced).toBeUndefined();
});

test('sync states map to one clear action', () => {
  expect(view(account, cloud({}), true).button).toEqual({label: '同步中…', action: 'sync', enabled: false});
  expect(view(account, cloud({phase: 'uploading', message: '正在上传手表状态'})).button?.enabled).toBe(false);
  expect(view(account, cloud({phase: 'error', message: '云同步失败，请稍后重试'}))).toMatchObject({title: '同步失败', button: {label: '重试', enabled: true}});
  expect(view(account, cloud({phase: 'waiting-approval'}))).toMatchObject({title: '需要云密钥授权', button: {action: 'approval'}});
  expect(view(account, cloud({phase: 'idle', message: '等待网络连接'}))).toMatchObject({title: '等待网络', button: {label: '重试'}});
  const done = view(account, cloud({phase: 'complete', message: '云同步完成', usedBytes: 256 << 20, quotaBytes: 1 << 30, lastCompletedAt: 500}));
  expect(done).toMatchObject({title: '已同步', space: {label: '已用 256 MB / 1 GB', fraction: 0.25}, button: {label: '立即同步', enabled: true}});
  expect(done.lastSynced).toStartWith('上次同步 今天');
  expect(view(account, cloud({phase: 'complete'})).space).toBeUndefined();
});

test('repeated manual sync taps join one run', async () => {
  let runs = 0, release!: () => void;
  const request = coalescedRequest(() => { runs++; return new Promise<void>(resolve => { release = resolve; }); });
  const first = request.start(), second = request.start();
  expect(first).toBe(second);
  expect(request.pending).toBe(true);
  await Promise.resolve();
  release();
  await first;
  expect(runs).toBe(1);
  expect(request.pending).toBe(false);
  await coalescedRequest(() => { throw Error('gate closed'); }).start();
});

test('same user on a different backend cannot leak the old cloud display',()=>{
 const snap=accountStatusSnapshot(account,500,{...cloud({phase:'complete',usedBytes:9,quotaBytes:10}),accountScope:JSON.stringify(['https://other.test',account.userId])})!;expect(snap.cloud?.phase).toBe('idle');expect(snap.cloud?.usedBytes).toBe(0);
});
test('v2 remediation view exposes confirmation, owner, upgrade and registration states without enabling commit cancellation',async()=>{
 const {cloudRemediationView}=await import('../src/ui/cloud-sync-view');
 const code=cloudRemediationView(accountStatusSnapshot(account,500,cloud({message:'本机资料属于其他账号'})),{phase:'code',message:'核对',code:'12345678',confirmed:false});expect(code).toMatchObject({canLogout:true,needsOwnerChoice:true,canConfirm:true,canDisagree:true,canCancel:true,approvalCode:'12345678'});
 expect(cloudRemediationView(accountStatusSnapshot(account,500,cloud({message:'设备公钥冲突，请重新登记本机'})),{phase:'committing',message:'保存中'})).toMatchObject({needsReregistration:true,canCancel:false,canConfirm:false,committing:true});
 expect(cloudRemediationView(accountStatusSnapshot(account,500,cloud({message:'请升级腕上RSS'})),{phase:'idle',message:''}).needsUpgrade).toBe(true);
});
test('local remediation callbacks require confirmation, coalesce busy actions and report failures without raw errors',async()=>{
 const {cloudRemediationActions}=await import('../src/ui/cloud-sync-view');let calls=0,release!:()=>void;const phases:boolean[]=[];
 const actions=cloudRemediationActions({logout:async()=>{calls++;await new Promise<void>(r=>{release=r;});},resolveOwner:async(_choice,_confirmed,clearLocal)=>{calls++;await clearLocal?.();},reregister:async()=>{calls++;throw Error('secret endpoint detail');}});actions.subscribe(()=>phases.push(actions.busy));
 expect(await actions.resolveOwner('merge',false)).toBe(false);expect(await actions.reregister(false)).toBe(false);expect(calls).toBe(0);const exiting=actions.logout();expect(actions.busy).toBe(true);expect(await actions.logout()).toBe(false);release();expect(await exiting).toBe(true);expect(phases).toEqual([true,false]);expect(await actions.reregister(true)).toBe(false);expect(actions.message).not.toContain('secret');
});

test('a backgrounded manual sync reads as handed off or held, never as finished', () => {
  const status = accountStatusSnapshot(account, 500, cloud({}));
  const queued = cloudSyncView(status, true, false, 500, 'queued');
  expect([queued.title, queued.tone, queued.button?.enabled]).toEqual(['后台同步中', 'busy', true]);
  const held = cloudSyncView(status, true, false, 500, 'held');
  expect([held.title, held.button?.enabled]).toEqual(['等待手机同步结束', false]);
  expect(cloudSyncView(status, true, false, 500, 'foreground').title).toBe(cloudSyncView(status, true, false, 500).title);
});
