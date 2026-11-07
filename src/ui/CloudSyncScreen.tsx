import type {CloudApprovalState as WatchApprovalState} from '../cloud/approval-controller.ts';
import type {CloudApproverState} from '../cloud/approver-controller.ts';
import {Text, View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {delay,type HostOperation} from '@podjs/framework/services';
import type {Scroller} from '@pocketjs/framework/kinetics';
import {createEffect, createMemo, createSignal, onCleanup} from 'solid-js';
import type {AccountStatusSnapshot} from '../account/status.ts';
import {cloudRemediationView, cloudSyncView, type CloudRemediationControl, type CloudSyncAction, type CloudSyncTone, type CloudSyncView} from './cloud-sync-view.ts';
import {PHONE_PAGE} from './phone-connection-layout.ts';
import {ScrollEntries, type ScrollEntry} from './ScrollEntries.tsx';
import {centredBounds} from './round-bounds.ts';
import {watchUiLines} from './text-layout.ts';

const TONE: Record<CloudSyncTone, string> = {
  ok: PHONE_PAGE.primary, busy: PHONE_PAGE.primary, attention: '#ffc266', error: '#ff7777', muted: PHONE_PAGE.secondary,
};
/** Narrower than the row so the pill's ends stay inside the circle wherever it lands on first show. */
const ACTION_WIDTH = 168, FACTS_WIDTH = 150, DETAIL_WIDTH = 176;

/** 我的 → 云同步 (native CloudSyncActivity). Opening only reads status; a sync starts on tap alone. */
export function CloudSyncScreen(props: {
  width: number;
  height: number;
  active: () => boolean;
  load: () => Promise<AccountStatusSnapshot | null>;
  subscribe?: (listener: () => void) => () => void;
  available: () => boolean;
  sync: {readonly pending: boolean; start(): Promise<void>};
  approval?: import('./cloud-sync-view').CloudApprovalControl;
  /** This watch approving another device of the same account (approval v2 approver). */
  approver?: {readonly state: CloudApproverState; subscribe(fn: () => void): () => void; accept(requestId: string): Promise<boolean>; confirm(match: boolean): Promise<boolean>; cancel(): Promise<boolean>};
  handoff?: {readonly state: {phase: import('./cloud-sync-view').CloudHandoffPhase}; subscribe(fn: () => void): () => void};
  /** Logout, owner choice and re-registration; every destructive action is armed by a first tap. */
  actions?: CloudRemediationControl;
  clearLocal?: () => Promise<void>;
  onPhone: () => void;
  onError: (message: string) => void;
  ref: (value: {scroller: Scroller}) => void;
}) {
  const [status, setStatus] = createSignal<AccountStatusSnapshot | null>();
  const [handoff, setHandoff] = createSignal(props.handoff?.state.phase ?? 'idle');
  if (props.handoff) onCleanup(props.handoff.subscribe(() => setHandoff(props.handoff!.state.phase)));
  const [available, setAvailable] = createSignal(props.available());
  const [pending, setPending] = createSignal(props.sync.pending);
  const [revision, setRevision] = createSignal(0);
  const [loadFailed, setLoadFailed] = createSignal(false);
  const [approval,setApproval]=createSignal<WatchApprovalState>(props.approval?.state??{phase:'idle',message:''});
  createEffect(()=>props.approval?.setForeground(props.active()));
  if(props.approval)onCleanup(props.approval.subscribe(()=>{setApproval(props.approval!.state);}));
  onCleanup(()=>props.approval?.setForeground(false));
  const [approver,setApprover]=createSignal<CloudApproverState|undefined>(props.approver?.state);
  if(props.approver)onCleanup(props.approver.subscribe(()=>setApprover(props.approver!.state)));
  const [actionRevision,setActionRevision]=createSignal(0);
  if(props.actions)onCleanup(props.actions.subscribe(()=>setActionRevision(value=>value+1)));
  // A destructive pill turns into its confirmation for four seconds after the first tap.
  const [armed,setArmed]=createSignal<string>();
  let disarm:HostOperation<void>|undefined;
  const cancelDisarm=()=>{
    const pending=disarm;disarm=undefined;
    // The host may already be closing; cleanup must still release this page.
    try{pending?.cancel();}catch{}
  };
  onCleanup(cancelDisarm);
  const arm=(key:string,run:()=>void)=>{
    if(armed()===key){cancelDisarm();setArmed(undefined);run();return;}
    cancelDisarm();setArmed(key);
    const pending=delay(4000);disarm=pending;
    const expire=()=>{if(disarm===pending){disarm=undefined;setArmed(undefined);}};
    // QuickJS has no browser timer globals. Cancellation and host failure both
    // disarm safely; stale completions cannot affect a newer confirmation.
    void pending.result.then(expire,expire);
  };
  const act=(work:Promise<unknown>|undefined)=>void work?.then(()=>setRevision(value=>value+1));
  let sequence = 0, disposed = false;
  if (props.subscribe) onCleanup(props.subscribe(() => { sequence++; setStatus(undefined); setLoadFailed(false); setRevision(value => value + 1); }));
  onCleanup(() => { sequence++; disposed = true; });
  const join = () => {
    setPending(true);
    void props.sync.start().then(() => { if (!disposed) { setPending(false); setRevision(value => value + 1); } });
  };
  if (props.sync.pending) join();
  createEffect(() => {
    revision();
    if (!props.active()) { sequence++; setStatus(undefined); return; }
    const request = ++sequence;
    void props.load().then(value => {
      // A later load (account change, new cloud status) supersedes this one.
      if (request === sequence && props.active()) { setStatus(value); setLoadFailed(false); setAvailable(props.available()); }
    }).catch(reason => {
      if (request === sequence && props.active()) { setStatus(undefined); setLoadFailed(true); props.onError('云同步状态读取失败，请重试。'); }
    });
  });
  const requestApproval=()=>{
    if(!props.active()||!props.approval||['requesting','committing'].includes(approval().phase))return;
    void props.approval.request().catch(()=>props.onError('暂时无法请求批准，请稍后重试。'));
  };
  const press = (action: CloudSyncAction) => {
    if (!props.active()) return;
    if (action === 'reload' && loadFailed()) { setLoadFailed(false); setRevision(value=>value+1); return; }
    const current = cloudSyncView(status(), available(), pending(), Date.now(), handoff()).button;
    if (!current?.enabled || current.action!==action) return;
    if (action === 'approval') requestApproval();
    else if (action === 'phone') props.onPhone();
    else if (!pending()) join();
  };

  const inner = () => props.width - 36;
  const measure = (text: string, slot: number) => getOps().measureText(text, slot);
  const gap = (height: number): ScrollEntry => ({height, render: () => null});
  const centred = (text: string, slot: number, lineHeight: number, color: string, width = inner()): ScrollEntry => {
    const lines = watchUiLines(text, {width, measure: line => measure(line, slot)});
    const height = lines.length * lineHeight;
    return {height, bounds: centredBounds(inner(), width, 0, height),
      render: () => <Text class="absolute text-center" style={{insetL: (inner() - width) / 2, insetT: 0, width, fontSlot: slot, lineHeight, textColor: color}}>{lines.join('\n')}</Text>};
  };

  const pill = (label: string, primary: boolean, onPress: () => void, enabled = true, danger = false): ScrollEntry => {
    const width = Math.min(ACTION_WIDTH, inner());
    const background = !enabled ? '#2a2a2a' : danger ? '#ff7777' : primary ? PHONE_PAGE.primary : '#2a2a2a';
    const foreground = !enabled ? PHONE_PAGE.secondary : primary || danger ? PHONE_PAGE.onPrimary : PHONE_PAGE.foreground;
    return {height: PHONE_PAGE.touchHeight, bounds: centredBounds(inner(), width, 0, PHONE_PAGE.touchHeight), render: () =>
      <View class="absolute rounded-[24] items-center justify-center active:scale-96" focusable={enabled}
        accessibilityRole="button" accessibilityLabel={label} accessibilityState={{disabled: !enabled}}
        onPress={enabled ? () => { if (props.active()) onPress(); } : undefined}
        style={{insetL: (inner() - width) / 2, insetT: 0, width, height: PHONE_PAGE.touchHeight, bgColor: background}}>
        <Text style={{fontSlot: 22, lineHeight: 21, textColor: foreground}}>{label}</Text>
      </View>};
  };
  const link = (label: string, onPress: () => void, enabled = true): ScrollEntry => {
    const width = Math.min(ACTION_WIDTH, inner());
    return {height: 36, bounds: centredBounds(inner(), width, 0, 36), render: () =>
      <View class="absolute items-center justify-center active:scale-96" focusable={enabled} accessibilityRole="button" accessibilityLabel={label}
        onPress={enabled ? () => { if (props.active()) onPress(); } : undefined}
        style={{insetL: (inner() - width) / 2, insetT: 0, width, height: 36}}>
        <Text style={{fontSlot: 1, lineHeight: 17, textColor: enabled ? PHONE_PAGE.secondary : '#555555'}}>{label}</Text>
      </View>};
  };

  const bar = (fraction: number): ScrollEntry => {
    const fill = Math.max(0, Math.round(FACTS_WIDTH * fraction));
    return {height: 4, bounds: centredBounds(inner(), FACTS_WIDTH, 0, 4), render: () =>
      <View class="absolute rounded-[2]" style={{insetL: (inner() - FACTS_WIDTH) / 2, insetT: 0, width: FACTS_WIDTH, height: 4, bgColor: '#2a2a2a'}}>
        <View class="absolute left-[0] top-[0] rounded-[2]" style={{width: fill, height: 4, bgColor: PHONE_PAGE.primary}}/>
      </View>};
  };

  const entries = createMemo<ScrollEntry[]>(() => {
    const view: CloudSyncView = loadFailed() ? {title:'状态读取失败',detail:'请重新读取云同步状态。',tone:'error',button:{label:'重新读取',action:'reload',enabled:true}} : cloudSyncView(status(), available(), pending(), Date.now(), handoff());
    const rows: ScrollEntry[] = [
      // Narrow bounds let the round layout start the page higher instead of pushing a full-width row down.
      {height: 26, bounds: centredBounds(inner(), Math.min(inner(), measure('云同步', 23) + 8), 0, 26), render: () => <Text class="absolute inset-0 text-center" style={{fontSlot: 23, lineHeight: 26, textColor: PHONE_PAGE.foreground}}>云同步</Text>},
      gap(10),
    ];
    const headline = Math.min(inner(), 16 + measure(view.title, 22));
    rows.push({height: 21, bounds: centredBounds(inner(), headline, 0, 21), render: () =>
      <View class="absolute" accessibilityLabel={view.title} style={{insetL: (inner() - headline) / 2, insetT: 0, width: headline, height: 21}}>
        <View class="absolute left-[0] top-[6.5] w-[8] h-[8] rounded-full" style={{bgColor: TONE[view.tone]}}/>
        <Text class="absolute left-[16] top-[0]" style={{fontSlot: 22, lineHeight: 21, textColor: PHONE_PAGE.foreground}}>{view.title}</Text>
      </View>});
    if (view.detail) rows.push(gap(4), centred(view.detail, 1, 17, PHONE_PAGE.secondary, Math.min(inner(), DETAIL_WIDTH)));
    // A request from another device replaces the sync action so it lands near the top of the round screen.
    const grant=approver(),grantActive=!!props.approver&&!!grant&&approval().phase==='idle'&&!['idle','unsupported'].includes(grant.phase);
    if(grantActive&&grant){
      // Another device asks this watch for the account key; it is sent only after both sides show the same digits.
      const target=grant.requests.find(r=>r.requestId===grant.requestId)??grant.requests[0],full=grant.requesterLabel||target?.requesterLabel||'新设备',label=Array.from(full).length>16?Array.from(full).slice(0,15).join('')+'…':full;
      rows.push(gap(14));
      if(grant.phase==='requested'&&target){
        rows.push(centred(`${label} 请求云同步授权`,1,17,PHONE_PAGE.foreground),gap(10),pill('核对授权码',true,()=>void props.approver!.accept(target.requestId)));
      }else if(grant.phase==='code'&&grant.code){
        const code=grant.code.length===8?`${grant.code.slice(0,4)} ${grant.code.slice(4)}`:grant.code;
        rows.push(centred('与另一台设备上的数字一致吗？',1,17,PHONE_PAGE.secondary),gap(6),
          {height:30,render:()=><Text class="absolute inset-0 text-center" accessibilityLabel={`核对码 ${grant.code}`} style={{fontSlot:23,lineHeight:30,textColor:PHONE_PAGE.foreground}}>{code}</Text>},
          gap(12),pill('一致',true,()=>void props.approver!.confirm(true)),gap(4),link('不一致',()=>void props.approver!.confirm(false)));
      }else{
        const failed=['error','expired','cancelled'].includes(grant.phase);
        rows.push(centred(grant.message,1,17,failed?'#ff7777':grant.phase==='complete'?PHONE_PAGE.primary:PHONE_PAGE.secondary));
        if(['accepting','waiting'].includes(grant.phase))rows.push(gap(4),link('取消',()=>void props.approver!.cancel()));
      }
    }
    const button = (grantActive&&['requested','accepting','waiting','code','delivering'].includes(grant!.phase))||['requesting','pending','code','committing'].includes(approval().phase)?undefined:view.button;
    if (button) {
      const width = Math.min(ACTION_WIDTH, inner());
      rows.push(gap(14), {height: PHONE_PAGE.touchHeight, bounds: centredBounds(inner(), width, 0, PHONE_PAGE.touchHeight), render: () =>
        <View class="absolute rounded-[24] items-center justify-center active:scale-96" focusable={button.enabled}
          accessibilityRole="button" accessibilityLabel={button.label} accessibilityState={{disabled: !button.enabled}}
          onPress={button.enabled ? () => press(button.action) : undefined}
          style={{insetL: (inner() - width) / 2, insetT: 0, width, height: PHONE_PAGE.touchHeight, bgColor: button.enabled ? PHONE_PAGE.primary : '#2a2a2a'}}>
          <Text style={{fontSlot: 22, lineHeight: 21, textColor: button.enabled ? PHONE_PAGE.onPrimary : PHONE_PAGE.secondary}}>{button.label}</Text>
        </View>});
    }
    actionRevision();
    const codeState=approval(),fix=cloudRemediationView(status(),codeState),actions=props.actions,busy=!!actions?.busy;
    if(props.approval&&fix.approvalCode&&['code','committing'].includes(codeState.phase)){
      // Both screens show the same digits; keys are accepted only after "一致" here.
      const code=fix.approvalCode.length===8?`${fix.approvalCode.slice(0,4)} ${fix.approvalCode.slice(4)}`:fix.approvalCode;
      rows.push(gap(14),centred('与另一台设备上的数字一致吗？',1,17,PHONE_PAGE.secondary),gap(6),
        {height:30,render:()=><Text class="absolute inset-0 text-center" accessibilityLabel={`核对码 ${fix.approvalCode}`} style={{fontSlot:23,lineHeight:30,textColor:PHONE_PAGE.foreground}}>{code}</Text>});
      if(fix.committing)rows.push(gap(10),centred('正在保存授权…',1,17,PHONE_PAGE.secondary));
      else if(fix.canConfirm)rows.push(gap(12),pill('一致',true,()=>void props.approval!.confirmMatches(true)),gap(4),link('不一致',()=>void props.approval!.confirmMatches(false)));
      else rows.push(gap(10),centred('已核对，等待授权完成',1,17,PHONE_PAGE.secondary),gap(4),link('不一致',()=>void props.approval!.confirmMatches(false),fix.canDisagree));
    } else if(props.approval&&codeState.phase!=='idle'){
      rows.push(gap(14),centred(codeState.message,1,17,codeState.phase==='error'?'#ff7777':PHONE_PAGE.secondary));
      if(fix.canCancel)rows.push(gap(4),link('取消',()=>void props.approval!.cancel()));
    }
    if(actions&&fix.needsOwnerChoice){
      rows.push(gap(12),pill(armed()==='clear'?'再按一次确认清空':'清空本机资料',armed()!=='clear',()=>arm('clear',()=>act(actions.resolveOwner('clear',true,props.clearLocal))),!busy&&!!props.clearLocal,armed()==='clear'),
        gap(8),pill(armed()==='merge'?'再按一次确认合并':'合并到当前账号',false,()=>arm('merge',()=>act(actions.resolveOwner('merge',true))),!busy,armed()==='merge'));
    }
    if(actions&&fix.needsReregistration)rows.push(gap(12),pill(armed()==='reregister'?'再按一次确认':'重新登记本机',armed()!=='reregister',()=>arm('reregister',()=>act(actions.reregister(true))),!busy,armed()==='reregister'));
    if(actions?.message)rows.push(gap(8),centred(actions.message,1,17,'#ff7777'));
    if (!fix.needsOwnerChoice && view.progress) rows.push(gap(14), bar(view.progress.fraction), gap(6), centred(view.progress.label, 0, 14, PHONE_PAGE.secondary, FACTS_WIDTH));
    if (!fix.needsOwnerChoice && (view.space || view.lastSynced)) rows.push(gap(14));
    if (!fix.needsOwnerChoice && view.space) {
      rows.push(bar(view.space.fraction), gap(6), centred(view.space.label, 0, 14, PHONE_PAGE.secondary, FACTS_WIDTH));
    }
    if (!fix.needsOwnerChoice && view.lastSynced) rows.push(gap(6), centred(view.lastSynced, 0, 14, PHONE_PAGE.secondary, FACTS_WIDTH));
    if(props.actions&&fix.canLogout&&!fix.needsOwnerChoice){
      rows.push(gap(20),pill(armed()==='logout'?'再按一次确认退出':'退出账号',false,()=>arm('logout',()=>act(props.actions!.logout())),!busy,armed()==='logout'),
        gap(4),centred('退出后本机文章保留，可登录其他账号。',0,14,PHONE_PAGE.secondary,FACTS_WIDTH));
    }
    rows.push(gap(24));
    return rows;
  });
  return <View class="absolute inset-0 bg-black">
    <ScrollEntries height={props.height} entries={entries()} padding={18} gap={0} inputActive={props.active} ref={props.ref}/>
  </View>;
}
