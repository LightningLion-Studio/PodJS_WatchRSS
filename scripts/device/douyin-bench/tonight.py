#!/usr/bin/env python3
"""Explicit watch-only acceptance: 20 natural completions, then 100 three-second swipes.
No ADB is executed without --execute. Output contains counters, never item IDs/URLs.
"""
from __future__ import annotations
import argparse,fcntl,io,json,re,signal,subprocess,threading,time
from pathlib import Path
from bench import Device,DEFAULT_OWNER,write_json
from analyzers import parse_log,quantiles


def decode_bundle(text):
    match=re.search(r'json=(\{.*\}), error=([^}]*)}',text,re.S)
    if 'ok=true' not in text or not match:raise RuntimeError('shell command failed: '+re.sub(r'json=.*','json=<omitted>',text).strip())
    return json.loads(match[1])


def transport_error(error):
    if isinstance(error,subprocess.TimeoutExpired):return True
    text=str(getattr(error,'stderr','') or '')+' '+str(getattr(error,'stdout','') or '')
    return isinstance(error,subprocess.CalledProcessError) and (getattr(error,'returncode',None) in [20,255] or bool(re.search(r'(?i)(device.*not found|device offline|transport.*(?:closed|error)|error: closed|connection.*closed|can.t find service|couldn.t find service|dead object)',text)))


def completion(state):
    return state.get('playbackState')=='ended' or state.get('completedLoops',0)>0


def presentation(events):
    releases=[e for e in events if e.get('code')=='gesture_release']
    if not releases:return None
    start=releases[-1]
    ends=[e for e in events if e.get('code')=='incoming_first_frame' and e.get('seq')==start.get('seq') and e.get('generation')==start.get('generation') and e.get('mono_ms',-1)>=start.get('mono_ms',0)]
    return ends[0]['mono_ms']-start['mono_ms'] if len(ends)==1 else None


def playback_stats(line):
    m=re.search(r'PodVideoStats\s*:\s*(retired|completed) source_ordinal=(\d+) source_generation=(\d+) position_ms=(\d+) first_frame_ms=(-?\d+) rebuffer_count=(\d+) dropped_frames=(\d+)(?: duration_ms=(\d+) ended=([01]))?\s*$',line.strip())
    if not m:return None
    return {'tag':'PodVideoStats','code':'playback_'+m[1],'source_ordinal':int(m[2]),'source_generation':int(m[3]),'position_ms':int(m[4]),'first_frame_ms':int(m[5]),'rebuffer_count':int(m[6]),'dropped_frames':int(m[7]),'duration_ms':int(m[8]) if m[8] else None,'ended':m[9]=='1'}


def black_image(data):
    from PIL import Image,ImageStat
    im=Image.open(io.BytesIO(data)).convert('RGB');w,h=im.size
    # Exclude the top controls, right side pill and bottom timeline. Inspect
    # the video interior, including side subjects that a center-only crop loses.
    interior=im.crop((int(w*.08),int(h*.22),int(w*.85),int(h*.74)))
    stat=ImageStat.Stat(interior)
    # A black scene can be legitimate content. Keep it as a suspicion for review.
    return max(stat.mean)<4 and max(stat.stddev)<4


def cache_transfer_stats(line):
    patterns=[
        ('cache_upstream_open',r'upstreamOpen entry=(\d+) position=(\d+) totalBytes=(-?\d+) prefixBytes=(\d+)',('entry_ordinal','position','total_bytes','prefix_bytes')),
        ('cache_range_transfer',r'range_transfer entry=(\d+) request=(\d+) position=(\d+) requested_bytes=(\d+) network_bytes=(\d+) ttfb_ms=(\d+) read_ms=(\d+) status=(\d+)',('entry_ordinal','request','position','requested_bytes','network_bytes','ttfb_ms','read_ms','status')),
        ('cache_prefix_hit',r'prefixHit bytes=(\d+) position=(\d+)',('bytes','position')),
    ]
    for code,pattern,keys in patterns:
        m=re.search(r'PodMediaCache\s*:\s*'+pattern+r'\s*$',line.strip())
        if m:return {'tag':'PodMediaCache','code':code,**dict(zip(keys,map(int,m.groups())))}
    return None


class Run:
    def __init__(self,out,resume=False,count=None,base_index=0,resource_interval=20):
        if resource_interval not in (10,20):raise ValueError("resource interval must be 10 or 20")
        self.resource_interval=resource_interval
        self.out=out;out.mkdir(parents=True,exist_ok=resume)
        self.device=Device('wrss-douyin-noplay');self.events=[];self.rows=[];self.log=None;self.thread=None;self.stats_tag_before=None;self.recovery_count=0;self.disconnect_times=[];self.interrupted_keys=set();self.last_state={};self.last_recovery_mono=0.;self._recovering=False;self.transport_halted=False;self.collection_restart_needed=False;self.app_pid=None;self.target_count=count;self.base_index=base_index;self.environment_pause=False;self.battery_guard_enabled=False;self.last_battery_check=0.
    def resource_sample_due(self,index):
        return index%self.resource_interval==0
    def shell(self,method):
        # State reads are idempotent. A transient ADB/Binder read failure must
        # not end a long playback run or replay a navigation command.
        attempts=3 if method=='douyin.state' else 1
        for attempt in range(1,attempts+1):
            try:
                if method=='douyin.state' and self.log is not None and not self._recovering and not self.transport_halted and not self.collection_restart_needed and self.log.poll() is not None:self.reconnect('logcat_exit')
                raw=self.device.call(['shell','content','call','--uri',f'content://{self.device.package}.podjs.shell','--method',method],timeout=30)
                if method=='douyin.state' and 'ok=false' in raw and re.search(r'error=timeout(?:[}\],]|$)',raw):raise TimeoutError('diagnostic_state_timeout')
                value=decode_bundle(raw)
                if method=='douyin.state':
                    self.last_state=value
                    if self.battery_guard_enabled:self.check_battery()
                return value
            except (subprocess.CalledProcessError,subprocess.TimeoutExpired,TimeoutError) as error:
                def safe(value):
                    text=value.decode(errors='replace') if isinstance(value,bytes) else str(value or '')
                    text=re.sub(r'https?://[^\s\"\)]+','<url>',text)
                    return re.sub(r'(?i)(Cookie|Authorization)\s*[:=].*',r'\1=<redacted>',text)[-1000:]
                with (self.out/'diagnostic-read-errors.jsonl').open('a') as f:
                    f.write(json.dumps({'method':method,'attempt':attempt,'host_mono':time.monotonic(),'kind':type(error).__name__,'exit_code':getattr(error,'returncode',None),'stdout':safe(getattr(error,'stdout',None)),'stderr':safe(getattr(error,'stderr',None))})+'\n')
                if self.log is not None and not self.transport_halted and not self.collection_restart_needed and method=='douyin.state' and transport_error(error):
                    return self.reconnect('state_transport')
                if attempt==attempts:raise
                time.sleep(.5*attempt)
        raise RuntimeError('diagnostic read retries exhausted')
    def check_battery(self):
        if time.monotonic()-self.last_battery_check<60:return
        raw=self.device.call(['shell','dumpsys','battery'],timeout=20);level=re.search(r'^\s*level:\s*(\d+)',raw,re.M)
        if not level:return
        self.last_battery_check=time.monotonic();number=len(list(self.out.glob('battery-*.txt')))+1;(self.out/f'battery-{number:04}.txt').write_text(raw)
        record={'host_mono':self.last_battery_check,'level_percent':int(level[1]),'fields':[x.strip() for x in raw.splitlines() if re.search(r'powered:|charging current:|status:|level:|temperature:',x)]}
        with (self.out/'battery-samples.jsonl').open('a') as file:file.write(json.dumps(record)+'\n')
        if record['level_percent']<20:
            self.environment_pause=True;self.battery_guard_enabled=False
            self.journal_interruption({'kind':'environment_interrupted','reason':'battery_below_20','host_mono':time.monotonic(),'level_percent':record['level_percent'],'resume_at_percent':30,'last_state':self.last_state,'playback_failure':False})
            raise RuntimeError('battery below twenty percent; pause for charging')
    def reconnect(self,reason):
        if self._recovering:raise RuntimeError('nested device recovery')
        now=time.monotonic();shared=self.out.parent/'connection-events.jsonl'
        history=[json.loads(line)['host_mono'] for line in shared.read_text().splitlines()] if shared.exists() else []
        self.disconnect_times=sorted({t for t in self.disconnect_times+history if 0<=now-t<=600});self.disconnect_times.append(now)
        with shared.open('a') as f:f.write(json.dumps({'host_mono':now,'reason':reason,'run':self.out.name})+'\n')
        key=(self.last_state.get('nativeSourceOrdinal'),self.last_state.get('sourceGeneration'))
        if key[0]:self.interrupted_keys.add(key)
        record={'kind':'collection_interrupted','reason':reason,'host_mono':now,'drops_in_10min':len(self.disconnect_times),'source_before':key}
        self.journal_interruption(record)
        if len(self.disconnect_times)>=3:
            self.transport_halted=True;raise RuntimeError('three collection disconnects within ten minutes')
        self._recovering=True
        try:
            if self.log:
                if self.log.poll() is None:self.log.terminate()
                try:self.log.wait(timeout=5)
                except subprocess.TimeoutExpired:self.log.kill();self.log.wait()
                if self.thread:self.thread.join(timeout=5)
            # A timeout is one continuing outage, not another disconnect.
            while True:
                try:
                    self.device.call(['wait-for-device'],timeout=45)
                    if self.app_pid:
                        try:pid=self.device.call(['shell','pidof',self.device.package]).strip()
                        except subprocess.CalledProcessError:pid=''
                        if pid!=self.app_pid:
                            self.collection_restart_needed=True
                            self.journal_interruption({'kind':'application_epoch_changed','host_mono':time.monotonic(),'makeup_required':True})
                            raise RuntimeError('application epoch changed; continue in a fresh collection segment')
                    raw=self.device.call(['shell','content','call','--uri',f'content://{self.device.package}.podjs.shell','--method','douyin.state'],timeout=30)
                    if not raw.strip():
                        self.journal_interruption({'kind':'waiting_for_shell_state','host_mono':time.monotonic(),'outage_started':now});time.sleep(1);continue
                    value=decode_bundle(raw)
                    if value.get('gestureLifecycleActive') is False:
                        focus=self.device.call(['shell','dumpsys','window'])
                        if any('mCurrentFocus=' in line and 'SysUI.Charging' in line for line in focus.splitlines()):
                            self.device.call(['shell','input','keyevent','131'])
                            self.device.call(['shell','am','start','-W','-n',self.device.package+'/dev.podjs.androidwatch.MainActivity'])
                            self.journal_interruption({'kind':'charging_cover_closed','host_mono':time.monotonic()})
                            value=decode_bundle(self.device.call(['shell','content','call','--uri',f'content://{self.device.package}.podjs.shell','--method','douyin.state'],timeout=30))
                    break
                except (subprocess.TimeoutExpired,subprocess.CalledProcessError):
                    self.journal_interruption({'kind':'waiting_for_device','host_mono':time.monotonic(),'outage_started':now})
            key=(value.get('nativeSourceOrdinal'),value.get('sourceGeneration'))
            if key[0]:self.interrupted_keys.add(key)
            self.recovery_count+=1;self.last_state=value;self.last_recovery_mono=time.monotonic()
            self.logs('-reconnect-'+str(self.recovery_count))
            self.journal_interruption({'kind':'collection_reconnected','host_mono':self.last_recovery_mono,'source_after':key,'makeup_required':True})
            return value
        finally:self._recovering=False
    def journal_interruption(self,record):
        with (self.out/'collection-interruptions.jsonl').open('a') as f:f.write(json.dumps(record)+'\n')
    def idempotent(self,work):
        for attempt in range(3):
            try:return work()
            except (subprocess.CalledProcessError,subprocess.TimeoutExpired) as error:
                if not transport_error(error) or attempt==2:raise
                self.device.call(['wait-for-device'],timeout=45)
    def picture(self,name):
        self.device.guard()
        data=subprocess.check_output(['adb','-s','e3aca8af','exec-out','screencap','-p'],timeout=15,stderr=subprocess.PIPE)
        path=self.out/(name+'.png');path.write_bytes(data);return path,black_image(data)
    def logs(self,suffix=''):
        self.battery_guard_enabled=True
        self.device.guard()
        if self.app_pid is None:self.app_pid=self.device.call(['shell','pidof',self.device.package]).strip()
        previous=self.stats_tag_before if self.stats_tag_before is not None else self.device.call(['shell','getprop','log.tag.PodVideoStats']).strip()
        if not re.fullmatch(r'[A-Za-z0-9_.-]{0,32}',previous):raise RuntimeError('unexpected native stats log level')
        self.stats_tag_before=previous;write_json(self.out/'native-stats-tag-before.json',{'value':previous})
        self.device.call(['shell','setprop','log.tag.PodVideoStats','INFO'])
        self.log=subprocess.Popen(['adb','-s','e3aca8af','logcat','-v','epoch','-T','1','DYBENCH:I','PodVideoCodec:I','PodMediaCache:I','PodVideoStats:I','PodInput:I','*:S'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1)
        def collect():
            with (self.out/('events'+suffix+'.jsonl')).open('w') as f, (self.out/('logcat'+suffix+'.txt')).open('w') as raw:
                for line in self.log.stdout:
                    event=parse_log(line)
                    if event is None and 'PodVideoCodec' in line:
                        m=re.search(r'event=(create|release) id=(\d+) owner=[a-zA-Z0-9_]+ priority=(\d+) live=(\d+) peak=(\d+)',line)
                        if m:event={'tag':'PodVideoCodec','code':m[1],'allocation':int(m[2]),'priority':int(m[3]),'live':int(m[4]),'peak':int(m[5])}
                    if event is None and 'PodInput' in line:
                        m=re.search(r'PodInput\s*:\s*(activity|runtime|frame)\s+((?:[a-z_]+=-?\d+\s*)+)$',line.strip())
                        if m:
                            values={k:int(v) for k,v in re.findall(r'([a-z_]+)=(-?\d+)',m[2])}
                            if set(values)<={'action','event_ms','received_ms','epoch_ms','moves','active','frames','receipt','dismiss','platform'}:event={'tag':'PodInput','code':'input_'+m[1],**values}
                    if event is None and 'PodVideoStats' in line:event=playback_stats(line)
                    if event is None and 'PodMediaCache' in line:
                        m=re.search(r'cache_failure operation=([a-zA-Z.]+) reason=([a-z_]+) stats=([01]) entries=(\d+) metadata_bytes=(\d+) http_status=(\d+) errno=(\d+)',line)
                        if m:event={'tag':'PodMediaCache','code':'cache_failure','operation':m[1],'reason':m[2],'stats_available':bool(int(m[3])),'registrations':int(m[4]),'metadata_bytes':int(m[5]),'http_status':int(m[6]),'errno':int(m[7])}
                        else:event=cache_transfer_stats(line)
                    if event:
                        # These native telemetry tags accept fixed enums and numbers.
                        # Retain original lines only after the safe parser accepts them.
                        raw.write(line);raw.flush()
                        event['host_mono']=time.monotonic();self.events.append(event);f.write(json.dumps(event)+'\n');f.flush()
        self.thread=threading.Thread(target=collect,daemon=True);self.thread.start()
    def restore_logs(self):
        try:
            if self.log:
                self.log.terminate()
                try:self.log.wait(timeout=5)
                except subprocess.TimeoutExpired:self.log.kill();self.log.wait()
                if self.thread:self.thread.join(timeout=5)
        finally:
            if self.stats_tag_before is not None:
                value=self.stats_tag_before
                self.idempotent(lambda:self.device.call(['shell','setprop','log.tag.PodVideoStats',value] if value else ['shell',"setprop log.tag.PodVideoStats ''"]))
                after=self.device.call(['shell','getprop','log.tag.PodVideoStats']).strip()
                write_json(self.out/'native-stats-tag-after.json',{'value':after,'restored':after==value})
                if after!=value:raise RuntimeError('native stats log level restoration mismatch')
    def sample(self,group,index,state):
        state=self.shell('douyin.state')
        pid=self.device.call(['shell','pidof',self.device.package]).strip().split()[0]
        raw=self.idempotent(lambda:self.device.call(['shell','dumpsys','meminfo',pid]));(self.out/f'{group}-{index:03}-meminfo.txt').write_text(raw)
        m=re.search(r'TOTAL PSS:\s*(\d+)',raw) or re.search(r'^\s*TOTAL\s+(\d+)',raw,re.M)
        pss=int(m[1]) if m else None
        row={'group':group,'index':index,'shell_pss_kib':state.get('pssKb'),'dumpsys_pss_kib':pss,'decoder_instances':state.get('decoderInstances'),'passed':pss is not None and pss<=125000 and state.get('decoderInstances',99)<=3}
        with (self.out/'resources.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
        return row
    def swipe(self):
        start=time.monotonic();self.device.swipe('next',duration_ms=600);self.last_swipe_ms=round((time.monotonic()-start)*1000);return start
    def next_after_interruption(self):
        while True:
            try:return self.swipe()
            except (subprocess.CalledProcessError,subprocess.TimeoutExpired) as error:
                if not transport_error(error):raise
                self.reconnect('navigation_transport')
    def item(self,group,index,action_at,previous):
        recovery_epoch=self.recovery_count;begin=time.monotonic();event_start=len(self.events);errors=[];seen=None;first=None;state={};done=False;reloaded=0;generations=set();black=False
        while event_start>0 and self.events[event_start-1].get('host_mono',0)>=action_at:event_start-=1
        last_progress=time.monotonic();last_position=None;stalling=False;stalls=0;max_no_progress=0.;start_delayed=False;first_metrics={};timer=None;swipe_result={};last_selected={};navigation_retries=0;navigation_actions=[]
        def leave():
            swipe_result['at']=time.monotonic()
            try:self.swipe();swipe_result['duration_ms']=self.last_swipe_ms
            except Exception as error:swipe_result['error']=type(error).__name__;swipe_result['transport_lost']=transport_error(error)
        while time.monotonic()-begin<max(900,state.get('durationMs',0)/1000+120):
            if group=='B' and swipe_result.get('at') is not None:break
            state=self.shell('douyin.state');stamp=time.monotonic()
            if group=='B' and swipe_result.get('at') is not None:
                if last_selected:state=last_selected
                break
            with (self.out/'samples.jsonl').open('a') as f:f.write(json.dumps({'group':group,'index':index,'host_mono':stamp,**state})+'\n')
            if state.get('page')!='video':errors.append('left_video_page');break
            ordinal=state.get('targetOrdinal',0)
            if seen is None and ordinal and ordinal!=previous:seen=ordinal
            if seen and ordinal!=seen:
                errors.append('automatic_transition_without_observed_completion');break
            if not seen:
                if group=='A' and completion(state) and navigation_retries<2 and stamp-begin>3*(navigation_retries+1):
                    navigation_retries+=1;at=self.swipe();navigation_actions.append({'attempt':navigation_retries+1,'host_mono':at,'duration_ms':self.last_swipe_ms,'previous_target':previous});continue
                if stamp-begin>30:errors.append('target_did_not_change');break
                time.sleep(.2);continue
            last_selected=state
            if state.get('sourceGeneration',0):generations.add(state['sourceGeneration'])
            reloaded=max(reloaded,max(0,len(generations)-1),int(state.get('reloadCount',0)))
            if state.get('hasRenderedFirstFrame') and state.get('playbackState')=='playing' and first is None:
                first=stamp;first_metrics=state
                if group=='B':timer=threading.Timer(3,leave);timer.start()
                try:_,black=self.picture(f'{group}-{index:03}-first')
                except (subprocess.CalledProcessError,subprocess.TimeoutExpired) as error:
                    if timer:timer.cancel();timer.join()
                    if not transport_error(error):raise
                    self.reconnect('first_frame_capture_transport')
                    self.journal_interruption({'kind':'discarded_item','group':group,'index':index,'target_ordinal':seen,'host_mono':time.monotonic(),'makeup_required':True,'playback_failure':False})
                    return seen or previous
                # The leave timer owns B's next ADB action. Do not overlap a
                # synchronous guest state query with the injected gesture.
                if group=='B':timer.join();break
            if state.get('playbackState')=='error':errors.append('playback_error');break
            if any(e.get('code') in ['error','error_page'] and e.get('is_prewarm')!='true' and e.get('failure_stage')!='capture' and e.get('host_mono',0)>=action_at for e in self.events[event_start:]):errors.append('native_player_error');break
            if first is None and stamp-begin>30:
                start_delayed=True
                if group=='B' and stamp-begin>=150:errors.append('playback_start_timeout_150s');break
            position=state.get('position',0)
            if position!=last_position:last_progress=stamp;last_position=position;stalling=False
            if (first is not None or group=='A' and state.get('hasRenderedFirstFrame')) and state.get('playbackState')!='ended':
                no_progress=stamp-last_progress;max_no_progress=max(max_no_progress,no_progress)
                if no_progress>15:
                    if not stalling:stalls+=1;stalling=True
                    # Natural playback must reach ended, or a real native error /
                    # the bounded whole-item deadline. Record slow-network stalls;
                    # a 15 s host cutoff must not preempt native's 25 s read retry.
                    if group!='A':errors.append('position_stalled_15s');break
            if group=='A' and completion(state):done=True;break
            if group=='B' and first is not None and stamp-first>=3:break
            time.sleep(.25 if first is None else .5)
        else:errors.append('natural_completion_timeout_900s')
        if group=='B' and first is None and errors:
            # Capture the still-selected failed page before the next input.
            try:self.picture(f'{group}-{index:03}-failure-before-leave')
            except (subprocess.CalledProcessError,subprocess.TimeoutExpired):pass
        if group=='B':
            if timer:timer.join()
            else:leave()
            self.following_action=swipe_result['at']
            if swipe_result.get('error'):errors.append('swipe_failed')
        if self.log is not None and (swipe_result.get('transport_lost') or self.log.poll() is not None):self.reconnect('swipe_or_logcat_transport')
        if self.recovery_count!=recovery_epoch:
            self.journal_interruption({'kind':'discarded_item','group':group,'index':index,'target_ordinal':seen,'host_mono':time.monotonic(),'makeup_required':True,'playback_failure':False})
            return seen or previous
        metrics_deadline=time.monotonic()+1
        while True:
            retired=[e for e in self.events if e.get('code')=='playback_retired' and e.get('source_ordinal')==first_metrics.get('nativeSourceOrdinal') and e.get('source_generation',-1)>=first_metrics.get('sourceGeneration',0) and e.get('host_mono',0)>=action_at] 
            if retired or group!='B' or not first_metrics or time.monotonic()>=metrics_deadline:break
            time.sleep(.05)
        if self.log is not None and self.log.poll() is not None:self.reconnect('retire_receipt_transport')
        if self.recovery_count!=recovery_epoch:
            self.journal_interruption({'kind':'discarded_item','group':group,'index':index,'host_mono':time.monotonic(),'makeup_required':True,'playback_failure':False})
            return seen or previous
        if group=='B' and first_metrics and not retired:errors.append('playback_metrics_missing')
        metrics_scope='last_shell_sample'
        if group=='B' and retired:
            value=retired[-1];reloaded=max(reloaded,int(value['source_generation']!=first_metrics.get('sourceGeneration')));state={**state,'rebufferCount':value['rebuffer_count'],'droppedFrames':value['dropped_frames']};metrics_scope='native_retire'
        progress_ms=retired[-1]['position_ms']-first_metrics.get('position',0) if retired and first_metrics else None
        if group=='B' and first_metrics and progress_ms is not None and progress_ms<=0 and state.get('durationMs',0)>3000:errors.append('position_did_not_advance')
        end_at=swipe_result.get('at',time.monotonic())
        ev=[e for e in self.events if action_at<=e.get('host_mono',0)<end_at]
        # Preserve native error events and explicitly separate speculative errors.
        native=[e for e in ev if e.get('code') in ['error','error_page'] and e.get('is_prewarm')!='true' and e.get('failure_stage')!='capture']
        if native:errors.append('native_player_error')
        if black:errors.append('black_frame_suspected')
        if (first is not None or state.get('hasRenderedFirstFrame')) and (first_metrics or state).get('firstFrameMs') is None:errors.append('first_frame_metric_missing')
        if group=='A' and not done:errors.append('not_completed')
        row={'group':group,'navigation_retries':navigation_retries,'navigation_actions':navigation_actions,'metrics_scope':metrics_scope,'playback_progress_ms':progress_ms,'native_retire_position_ms':retired[-1]['position_ms'] if retired else None,'index':index,'target_ordinal':seen,'native_prepare_first_frame_ms':(first_metrics or state).get('firstFrameMs') if seen is not None else None,'input_to_presented_ms':presentation(ev),'first_frame_observed_upper_bound_ms':round((first-action_at)*1000) if first else None,'start_delay_over_30s':start_delayed,'stutter_observed':reloaded>0 or (progress_ms is not None and progress_ms<=0) or start_delayed or stalls>0 or state.get('rebufferCount',0)>0 or state.get('droppedFrames',0)>0,'stalls_over_15s':stalls,'max_no_progress_ms':round(max_no_progress*1000),'rebuffer_count':state.get('rebufferCount'),'dropped_frames':state.get('droppedFrames'),'reloads':reloaded,'black_suspected':black,'cache_failure_events':sum(e.get('code')=='cache_failure' for e in ev),'completed':done if group=='A' else None,'position_ms':state.get('position'),'duration_ms':state.get('durationMs'),'leave_input_duration_ms':swipe_result.get('duration_ms'),'observed_after_first_frame_s':round((swipe_result.get('at',time.monotonic())-first),3) if first else 0,'errors':errors,'status':'FAIL' if errors else 'PASS'}
        if errors:
            write_json(self.out/f'{group}-{index:03}-failure-log.json',ev)
            self.picture(f'{group}-{index:03}-failure')
        if group=='B' and self.resource_sample_due(index):row['resource_sample']=self.sample(group,index,state)
        if self.recovery_count!=recovery_epoch:
            self.journal_interruption({'kind':'discarded_item','group':group,'index':index,'host_mono':time.monotonic(),'makeup_required':True,'playback_failure':False,'resource_sample':row.get('resource_sample')})
            return seen or previous
        with (self.out/'items.jsonl').open('a') as f:f.write(json.dumps(row,ensure_ascii=False)+'\n')
        self.rows.append(row);print(json.dumps(row,ensure_ascii=False),flush=True)
        return seen or previous
    def final_transition(self,previous):
        self.final_transition_passed=False
        self.swipe();deadline=time.monotonic()+30;state={}
        while time.monotonic()<deadline:
            state=self.shell('douyin.state')
            if state.get('targetOrdinal',0) not in (0,previous) and state.get('hasRenderedFirstFrame') and state.get('playbackState')=='playing':
                self.final_transition_passed=True;break
            time.sleep(.25)
        write_json(self.out/'A-final-transition.json',{'passed':self.final_transition_passed,**state})
        if not self.final_transition_passed:
            self.picture('A-final-transition-failure')
            raise RuntimeError('final completed video did not enter the next playing target')
    def execute(self,groups):
        # Keep a separate OS lock as well as the shared ownership marker.
        with open(str(DEFAULT_OWNER)+'.lock','a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            if DEFAULT_OWNER.read_text().strip()!='released':raise RuntimeError('another device owner is active')
            DEFAULT_OWNER.write_text(self.device.owner+'\n');settings={};restored=False
            try:
                for key in ['screen_brightness','screen_brightness_mode','screen_off_timeout']:settings[key]=self.device.setting(key)
                write_json(self.out/'settings-before.json',settings)
                self.device.setting('screen_brightness_mode',0);self.device.setting('screen_brightness',10);self.device.setting('screen_off_timeout',600000)
                self.device.key(224);time.sleep(1.5);self.device.call(['shell','input','keyevent','131']);time.sleep(.5)
                self.device.call(['shell','am','start','-W','-n',self.device.package+'/dev.podjs.androidwatch.MainActivity'])
                time.sleep(3)
                window=self.device.call(['shell','dumpsys','window'])
                focus=[line.strip() for line in window.splitlines() if 'mCurrentFocus=' in line]
                write_json(self.out/'initial-focus.json',focus)
                if any('SysUI.Charging' in line for line in focus):
                    self.device.call(['shell','input','keyevent','131']);time.sleep(.5)
                self.logs()
                self.shell('douyin.open');time.sleep(2)
                # Use the same explicit upward gesture as the product. Binder
                # play has a separate 10 s deadline and can cancel a slow feed.
                time.sleep(5)
                action=time.monotonic()
                self.device.call(['shell','input','swipe','233','350','233','130','400'])
                deadline=time.monotonic()+60;retry_at=time.monotonic()+15;retries=0
                while True:
                    initial=self.shell('douyin.state')
                    if initial.get('page')=='video':break
                    if initial.get('page') not in ['douyin.entry'] or time.monotonic()>deadline:
                        self.picture('start-failure');raise RuntimeError('natural entry did not reach the video page')
                    if time.monotonic()>=retry_at and retries<3:
                        self.device.call(['shell','input','swipe','233','350','233','130','400']);retries+=1;retry_at=time.monotonic()+15
                    time.sleep(.5)
                write_json(self.out/'start.json',initial)
                previous=0
                for group,count in [('A',20),('B',self.target_count or 100)]:
                    if group not in groups:continue
                    if group=='A':self.final_transition_passed=False
                    if previous:action=self.swipe()
                    index=self.base_index+1
                    while index<=self.base_index+count:
                        size=len(self.rows)
                        try:previous=self.item(group,index,action,previous)
                        except (subprocess.CalledProcessError,subprocess.TimeoutExpired) as error:
                            if not transport_error(error):raise
                            self.reconnect('item_transport')
                            self.journal_interruption({'kind':'discarded_item','group':group,'index':index,'host_mono':time.monotonic(),'makeup_required':True,'playback_failure':False})
                        if len(self.rows)==size:
                            action=self.next_after_interruption();continue
                        index+=1
                        if group=='B':action=self.following_action
                        elif index<=self.base_index+count:action=self.swipe()
                    if group=='A':self.final_transition(previous)
            except Exception as error:
                screenshot_error=None
                try:self.picture('run-interrupted')
                except Exception as picture_error:screenshot_error=type(picture_error).__name__
                write_json(self.out/'interruption.json',{'kind':type(error).__name__,'completed_rows':len(self.rows),'screenshot_error_kind':screenshot_error})
                raise
            finally:
                self.battery_guard_enabled=False
                try:
                    self.restore_logs()
                    for key,value in settings.items():self.idempotent(lambda k=key,v=value:self.device.setting(k,v))
                    after={key:self.device.setting(key) for key in settings};write_json(self.out/'settings-after.json',after)
                    restored=after==settings
                    if not restored:raise RuntimeError('screen settings restoration mismatch')
                    self.device.key(223)
                finally:
                    DEFAULT_OWNER.write_text('released\n')
                    playback_pass=len(self.rows)==sum(20 if g=='A' else self.target_count or 100 for g in groups) and all(r['status']=='PASS' for r in self.rows) and getattr(self,'final_transition_passed',True)
                    resources_pass=('B' not in groups or sum('resource_sample' in r for r in self.rows)==sum(self.resource_sample_due(i) for i in range(self.base_index+1,self.base_index+(self.target_count or 100)+1))) and all(r.get('resource_sample',{'passed':True})['passed'] for r in self.rows)
                    write_json(self.out/'summary.json',{'status':'INTERRUPTED' if self.transport_halted or self.collection_restart_needed or self.environment_pause else 'PASS' if playback_pass and resources_pass else 'FAIL','playback_status':'INCOMPLETE' if self.transport_halted or self.collection_restart_needed or self.environment_pause else 'PASS' if playback_pass else 'FAIL','collection_reconnections':self.recovery_count,'collection_halted':self.transport_halted,'collection_restart_needed':self.collection_restart_needed,'environment_paused':self.environment_pause,'playback_failures':sum(bool(r['errors']) for r in self.rows),'resource_status':'PASS' if resources_pass else 'FAIL','pss_limit_kib':125000,'resource_interval':self.resource_interval,'final_transition_passed':getattr(self,'final_transition_passed',None),'groups':groups,'navigation_retries':sum(r.get('navigation_retries',0) for r in self.rows),'native_retire_metrics':sum(r.get('metrics_scope')=='native_retire' for r in self.rows),'attempts':len(self.rows),'passed':sum(r['status']=='PASS' for r in self.rows),'first_frame_native_ms':quantiles([r['native_prepare_first_frame_ms'] for r in self.rows if r['native_prepare_first_frame_ms'] is not None]),'settings_restored':restored})


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--execute',action='store_true');p.add_argument('--output',type=Path);p.add_argument('--count',type=int);p.add_argument('--base-index',type=int,default=0);p.add_argument('--resource-interval',type=int,choices=[10,20],default=20);p.add_argument('--groups',choices=['A','B','AB'],default='AB');args=p.parse_args()
    if not args.execute:print(f'Offline plan: A=20 natural completions; B=100 swipes, 3 seconds after first frame, PSS/decoder samples every {args.resource_interval}. No ADB executed.');return
    if args.output is None:p.error('--output required with --execute')
    for sig in [signal.SIGTERM,signal.SIGINT]:signal.signal(sig,lambda *_:(_ for _ in ()).throw(KeyboardInterrupt()))
    if args.count is not None and (args.groups!='B' or not 1<=args.count<=100 or not 0<=args.base_index<100 or args.base_index+args.count>100):p.error('--count is a bounded B-only segment')
    Run(args.output,count=args.count,base_index=args.base_index,resource_interval=args.resource_interval).execute(list(args.groups))
if __name__=='__main__':main()
