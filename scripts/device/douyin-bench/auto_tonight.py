#!/usr/bin/env python3
"""Watch-only natural completion acceptance using the product's next mode.

No seeking or speed changes. Native ENDED receipts, rather than a near-end
position or a cached picture, authorize each completed item. Default is offline.
"""
from __future__ import annotations
import argparse,fcntl,json,re,signal,time
from pathlib import Path
from bench import DEFAULT_OWNER,write_json
from tonight import Run,quantiles


def receipt_key(value):
    return value.get('source_ordinal'),value.get('source_generation')


def terminal_player_failure(events):
    return any(event.get('code')=='error_page' and event.get('reason')=='exhausted'
               and str(event.get('is_prewarm')).lower()!='true'
               and event.get('failure_stage')!='capture' for event in events)


def natural_row(event,index,errors=()):
    problems=list(errors)
    valid=(event.get('ended') is True and (event.get('duration_ms') or 0)>0
           and event.get('position_ms',0)>=event['duration_ms']-250
           and event.get('first_frame_ms',-1)>=0)
    if not valid:problems.append('native_end_receipt_missing')
    return {'group':'A','index':index,'native_source_ordinal':event.get('source_ordinal'),
            'source_generation':event.get('source_generation'),
            'native_prepare_first_frame_ms':event.get('first_frame_ms') if event.get('first_frame_ms',-1)>=0 else None,
            'duration_ms':event.get('duration_ms'),'position_ms':event.get('position_ms'),
            'completed':valid,'rebuffer_count':event.get('rebuffer_count',0),
            'dropped_frames':event.get('dropped_frames',0),'reloads':0,
            'stutter_observed':event.get('rebuffer_count',0)>0 or event.get('dropped_frames',0)>0,
            'errors':problems,'status':'FAIL' if problems else 'PASS',
            'completion_proof':'native_ended','end_receipt':event}


class AutoRun(Run):
    def __init__(self,out,resume=False,count=20,base_index=0,refresh_entry=False):
        super().__init__(out,resume);self.first_seen={};self.reload_counts={};self.resume=resume;self.count=count;self.base_index=base_index;self.refresh_entry=refresh_entry

    def current(self,index):
        value=self.shell('douyin.state')
        key=(value.get('nativeSourceOrdinal'),value.get('sourceGeneration'))
        self.reload_counts[key]=max(self.reload_counts.get(key,0),int(value.get('reloadCount',0)))
        if value.get('hasRenderedFirstFrame') and value.get('playbackState')=='playing':self.first_seen.setdefault((value.get('nativeSourceOrdinal'),value.get('sourceGeneration')),time.monotonic())
        with (self.out/'samples.jsonl').open('a') as file:
            file.write(json.dumps({'group':'A','index':index,'host_mono':time.monotonic(),**value})+'\n')
        return value

    def mode(self,wanted):
        for _ in range(8):
            value=self.shell('douyin.state')
            if value.get('loopModeIndex')==wanted:return value
            if value.get('loopModeCount',0)<3:raise RuntimeError('automatic next mode unavailable')
            # Hidden controls consume the first tap by becoming visible. Read
            # back the mode after every tap; never infer it from tap count.
            self.device.call(['shell','input','tap','233','60']);time.sleep(.5)
        raise RuntimeError('loop mode readback did not match')

    def following(self,previous,index):
        start=time.monotonic();fallback=False
        while time.monotonic()-start<90:
            value=self.current(index)
            key=(value.get('nativeSourceOrdinal'),value.get('sourceGeneration'))
            if key!=previous and value.get('hasRenderedFirstFrame') and value.get('playbackState')=='playing':return value
            if not fallback and time.monotonic()-start>20 and key==previous and value.get('playbackState')=='ended':
                # Same normal product action as Next. It is only allowed after
                # the previous source actually ended, and is always recorded.
                fallback=True;record={'after_index':index-1,'host_mono':time.monotonic(),'method':'douyin.next'}
                try:self.shell('douyin.next');record['result']='returned'
                except Exception as error:record['result']=type(error).__name__
                with (self.out/'next-fallbacks.jsonl').open('a') as file:file.write(json.dumps(record)+'\n')
            time.sleep(1)
        raise RuntimeError('completed source did not enter the next playing target')

    def execute_auto(self):
        with open(str(DEFAULT_OWNER)+'.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            if DEFAULT_OWNER.read_text().strip()!='released':raise RuntimeError('another device owner is active')
            DEFAULT_OWNER.write_text(self.device.owner+'\n');before={};original_mode=None;mode_restored=False;restored=False;awake_before=None;awake_restored=False
            self.final_transition_passed=False
            try:
                if self.resume:
                    handoff=json.loads((self.out/'collector-handoff.json').read_text())
                    if self.device.call(['shell','pidof',self.device.package]).strip()!=handoff['app_pid']:raise RuntimeError('native player process changed during collector handoff')
                    before=json.loads((self.out/'settings-before.json').read_text());awake_before=json.loads((self.out/'stay-awake-before.json').read_text())['value'] if (self.out/'stay-awake-before.json').exists() else None;original_mode=json.loads((self.out/'loop-before.json').read_text())['mode']
                    self.events=[json.loads(line) for line in (self.out/'events.jsonl').read_text().splitlines()]
                    for line in (self.out/'samples.jsonl').read_text().splitlines():
                        sample=json.loads(line)
                        if sample.get('hasRenderedFirstFrame') and sample.get('playbackState')=='playing':self.first_seen.setdefault((sample.get('nativeSourceOrdinal'),sample.get('sourceGeneration')),sample['host_mono'])
                    (self.out/'items.jsonl').rename(self.out/'items-initial-collector.jsonl')
                    self.logs('-continued');value=self.current(0)
                    if value.get('loopModeIndex')!=2:raise RuntimeError('automatic mode changed during collector handoff')
                    selection_started=handoff['test_started'];handoff['after_state']=value;handoff['after_host_mono']=time.monotonic();write_json(self.out/'collector-handoff.json',handoff)
                else:
                    before={key:self.device.setting(key) for key in ['screen_brightness','screen_brightness_mode','screen_off_timeout']}
                    write_json(self.out/'settings-before.json',before)
                    self.device.setting('screen_brightness_mode',0);self.device.setting('screen_brightness',10)
                    self.device.setting('screen_off_timeout',43200000)
                    # Keep a charging watch awake across natural ENDED -> next
                    # gaps without touching playback or resetting its clock.
                    awake_value=self.device.call(['shell','settings','get','global','stay_on_while_plugged_in']).strip()
                    if not re.fullmatch(r'(?:null|[0-7])',awake_value):raise RuntimeError('unexpected charging-awake setting')
                    awake_before=awake_value;write_json(self.out/'stay-awake-before.json',{'value':awake_before})
                    self.device.call(['shell','settings','put','global','stay_on_while_plugged_in','7'])
                    awake_during=self.device.call(['shell','settings','get','global','stay_on_while_plugged_in']).strip();write_json(self.out/'stay-awake-during.json',{'value':awake_during});assert awake_during=='7'
                    write_json(self.out/'charging-state.json',[line.strip() for line in self.device.call(['shell','dumpsys','battery']).splitlines() if 'powered:' in line])
                    self.device.key(224);time.sleep(1.5);self.device.call(['shell','input','keyevent','131']);time.sleep(.5)
                    self.device.call(['shell','am','start','-W','-n',self.device.package+'/dev.podjs.androidwatch.MainActivity']);time.sleep(3)
                    focus=self.device.call(['shell','dumpsys','window'])
                    write_json(self.out/'initial-focus.json',[line for line in focus.splitlines() if 'mCurrentFocus=' in line])
                    if any('mCurrentFocus=' in line and 'SysUI.Charging' in line for line in focus.splitlines()):self.device.call(['shell','input','keyevent','131'])
                    self.logs();self.shell('douyin.open');time.sleep(5)
                    if self.refresh_entry:
                        refresh_at=time.monotonic();self.device.call(['shell','input','swipe','233','150','233','350','600']);deadline=time.monotonic()+45;done=False
                        while time.monotonic()<deadline:
                            self.current(0)
                            starts=[event for event in self.events if event.get('host_mono',0)>=refresh_at and event.get('code')=='refresh_start']
                            if starts and any(event.get('code')=='refresh_done' and event.get('seq')==starts[-1].get('seq') for event in self.events):done=True;break
                            time.sleep(1)
                        write_json(self.out/'entry-refresh-after-environment.json',{'normal_pull_gesture':True,'completion_receipt':done,'reason':'new replacement run after an environment interruption'})
                    deadline=time.monotonic()+150;retry_at=0;selection_started=None
                    while time.monotonic()<deadline:
                        value=self.current(1)
                        if value.get('page')=='video' and value.get('loopModeIndex',-1)>=0:break
                        if value.get('page')=='douyin.entry' and time.monotonic()>=retry_at:
                            if selection_started is None:selection_started=time.monotonic()
                            self.device.call(['shell','input','swipe','233','350','233','130','600']);retry_at=time.monotonic()+15
                        time.sleep(.5)
                    else:raise RuntimeError('natural entry did not obtain a ready player')
                    original_mode=value['loopModeIndex'];write_json(self.out/'loop-before.json',{'mode':original_mode})
                    write_json(self.out/'loop-during.json',self.mode(2))
                seen=set();boundary=selection_started or time.monotonic();test_started=boundary;eligible={(value.get('nativeSourceOrdinal'),value.get('sourceGeneration'))};current=value;errors_seen=set()
                for local_index in range(1,self.count+1):
                    index=self.base_index+local_index
                    began=time.monotonic();last_read=0;recovery_epoch=self.recovery_count
                    while True:
                        if self.recovery_count!=recovery_epoch:
                            began=time.monotonic();boundary=self.last_recovery_mono;recovery_epoch=self.recovery_count
                        events=list(self.events)
                        eligible.update(self.first_seen);eligible.update(receipt_key(event) for event in events if event.get('host_mono',0)>=test_started and event.get('code')=='prepare_stage' and (event.get('prepare_stage')=='adopt' or event.get('prepare_stage')=='start' and str(event.get('is_prewarm')).lower()!='true'))
                        candidates=[event for event in events if event.get('host_mono',0)>=test_started and receipt_key(event) in eligible and event.get('code') in ['playback_completed','playback_retired'] and event.get('ended') and receipt_key(event) not in seen and receipt_key(event) not in self.interrupted_keys]
                        if candidates:
                            end=candidates[0];seen.add(receipt_key(end))
                            errors=[event for event in events if max(boundary,self.last_recovery_mono)<=event.get('host_mono',0)<=end.get('host_mono',0) and event.get('code') in ['error','error_page'] and event.get('is_prewarm')!='true' and event.get('failure_stage')!='capture']
                            row=natural_row(end,index,['native_player_error'] if errors else ())
                            row['native_error_events']=len(errors)
                            observed=self.first_seen.get(receipt_key(end));row['first_frame_observed_upper_bound_ms']=max(0,round((observed-boundary)*1000)) if observed is not None else None
                            generations={event.get('source_generation') for event in events if event.get('code')=='prepare_stage' and event.get('prepare_stage')=='start' and event.get('source_ordinal')==end.get('source_ordinal')}
                            row['reloads']=max(0,len(generations)-1,self.reload_counts.get(receipt_key(end),0))
                            row['stutter_observed']=row['stutter_observed'] or row['reloads']>0
                            self.rows.append(row)
                            with (self.out/'items.jsonl').open('a') as file:file.write(json.dumps(row)+'\n')
                            if row['errors']:
                                self.picture(f'A-{index:03}-failure');write_json(self.out/f'A-{index:03}-failure-log.json',errors)
                            print(json.dumps(row),flush=True);boundary=end['host_mono'];break
                        if time.monotonic()-last_read>=4:
                            current=self.current(index);last_read=time.monotonic()
                            if self.rows and receipt_key(self.rows[-1]['end_receipt'])==(current.get('nativeSourceOrdinal'),current.get('sourceGeneration')) and current.get('playbackState')=='ended' and time.monotonic()-began>20:
                                current=self.following(receipt_key(self.rows[-1]['end_receipt']),index)
                        recent=[event for event in events if event.get('host_mono',0)>=boundary and event.get('code') in ['error','error_page'] and event.get('is_prewarm')!='true' and event.get('failure_stage')!='capture']
                        for event in recent:
                            token=(event.get('seq'),event.get('code'))
                            if token not in errors_seen:
                                errors_seen.add(token);self.picture(f'A-{index:03}-error-observed');write_json(self.out/f'A-{index:03}-observed-errors.json',recent)
                        if terminal_player_failure(recent):
                            row={'group':'A','index':index,'completed':False,'status':'FAIL','errors':['native_player_error','not_completed'],'native_prepare_first_frame_ms':current.get('firstFrameMs'),'duration_ms':current.get('durationMs',0),'rebuffer_count':current.get('rebufferCount',0),'dropped_frames':current.get('droppedFrames',0),'reloads':0}
                            self.rows.append(row)
                            with (self.out/'items.jsonl').open('a') as file:file.write(json.dumps(row)+'\n')
                            self.picture(f'A-{index:03}-failure');write_json(self.out/f'A-{index:03}-failure-log.json',recent)
                            raise RuntimeError('native player recovery exhausted')
                        if time.monotonic()-began>max(900,current.get('durationMs',0)/1000+120):raise RuntimeError('natural completion deadline exceeded')
                        time.sleep(.25)
                final=self.following(receipt_key(self.rows[-1]['end_receipt']),self.base_index+self.count+1)
                self.final_transition_passed=True;write_json(self.out/'A-final-transition.json',{'passed':True,**final})
            except Exception as error:
                picture_error=None
                try:self.picture('run-interrupted')
                except Exception as capture_error:picture_error=type(capture_error).__name__
                write_json(self.out/'interruption.json',{'kind':type(error).__name__,'completed_rows':len(self.rows),'screenshot_error':picture_error})
                raise
            finally:
                self.battery_guard_enabled=False
                try:
                    try:
                        if original_mode is not None:
                            self.shell('douyin.pause');write_json(self.out/'loop-after.json',self.mode(original_mode));mode_restored=True
                    finally:
                        self.restore_logs()
                finally:
                    try:
                        if awake_before is not None:
                            self.idempotent(lambda:self.device.call(['shell','settings','delete','global','stay_on_while_plugged_in'] if awake_before=='null' else ['shell','settings','put','global','stay_on_while_plugged_in',awake_before]))
                            awake_after=self.device.call(['shell','settings','get','global','stay_on_while_plugged_in']).strip();awake_restored=awake_after==awake_before;write_json(self.out/'stay-awake-after.json',{'value':awake_after,'restored':awake_restored})
                        for key,value in before.items():self.idempotent(lambda k=key,v=value:self.device.setting(k,v))
                        after={key:self.device.setting(key) for key in before};write_json(self.out/'settings-after.json',after)
                        restored=after==before
                        if before:self.device.key(223)
                    finally:
                        DEFAULT_OWNER.write_text('released\n')
                        passed=len(self.rows)==self.count and all(row['status']=='PASS' for row in self.rows) and self.final_transition_passed
                        write_json(self.out/'summary.json',{'status':'INTERRUPTED' if self.transport_halted or self.collection_restart_needed or self.environment_pause else 'PASS' if passed and restored and mode_restored and (awake_restored or awake_before is None) else 'FAIL','playback_status':'INCOMPLETE' if self.transport_halted or self.collection_restart_needed or self.environment_pause else 'PASS' if passed else 'FAIL','collection_halted':self.transport_halted,'collection_restart_needed':self.collection_restart_needed,'environment_paused':self.environment_pause,'playback_failures':sum(bool(row['errors']) for row in self.rows),'attempts':len(self.rows),'passed':sum(row['status']=='PASS' for row in self.rows),'groups':['A'],'mode':'product_auto_next','first_frame_native_ms':quantiles([row['native_prepare_first_frame_ms'] for row in self.rows if row['native_prepare_first_frame_ms'] is not None]),'final_transition_passed':self.final_transition_passed,'settings_restored':restored,'loop_mode_restored':mode_restored,'stay_awake_restored':awake_restored,'collection_reconnections':self.recovery_count,'interrupted_native_sources':sorted(self.interrupted_keys)})


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--execute',action='store_true');parser.add_argument('--resume',action='store_true');parser.add_argument('--count',type=int,default=20);parser.add_argument('--base-index',type=int,default=0);parser.add_argument('--refresh-entry',action='store_true');parser.add_argument('--output',type=Path);args=parser.parse_args()
    if not args.execute:print(json.dumps({'device':'e3aca8af','group':'A','count':20,'mode':'product_auto_next','execute':False}));return
    if args.output is None:parser.error('--output is required with --execute')
    for code in [signal.SIGINT,signal.SIGTERM]:signal.signal(code,lambda *_:(_ for _ in ()).throw(KeyboardInterrupt()))
    if not 1<=args.count<=20 or not 0<=args.base_index<20 or args.base_index+args.count>20:parser.error('segment must fit within twenty acceptance items')
    AutoRun(args.output,args.resume,args.count,args.base_index,args.refresh_entry).execute_auto()


if __name__=='__main__':main()
