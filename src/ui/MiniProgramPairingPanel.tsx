import {miniProgramPairingHostPorts} from './mini-program-pairing-host';
import type {Scroller} from '@pocketjs/framework/kinetics';
import {createEffect,createMemo,createSignal,onCleanup} from 'solid-js';
import {Image,Text,View} from '@pocketjs/framework/components';
import {getOps} from '@pocketjs/framework/host';
import {delay} from '@podjs/framework/services';
import {getDisplayMetrics} from '@podjs/framework/watch';
import {QRCode as FrameworkQRCode,qrPixels} from '@podjs/framework/qr';
import {chunkLines} from './round-rows.tsx';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import {PHONE_PAGE,phonePageText,type PhoneTextKind} from './phone-connection-layout.ts';
import {WatchProgressIndicator} from './WatchProgressIndicator.tsx';
import {MiniProgramPairing,PAIRING_STEPS,isLivePairing,pairingCountdown,pairingDoneDetail,pairingDoneTitle,pairingScanHint,pairingStartingLabel,type PairingPorts,type PairingState,type PairingTransport} from './mini-program-pairing.ts';

/** White tile edge; corners stay inside the round viewport. Quiet zone keeps scanners locked on. */
const QR_QUIET=8;
/** Dark-on-white, low error correction: the fewest, largest modules for the one-time payload. */
const pairingRaster=(value:string,dimension:number)=>qrPixels(value,dimension,{encoding:'byte',bitmapSize:dimension,errorCorrection:'L',margin:0,invert:false,messages:{content:'配对码生成失败',raster:'配对码生成失败',capacity:'配对码生成失败'}});

/** Foreground-only pairing page; starts once when opened by an explicit tap and owns its session. */
export function MiniProgramPairingPanel(props:{width:number;height:number;active:()=>boolean;transport?:PairingTransport;onClose:()=>void;onDone?:()=>void;ref:(value:{scroller:Scroller;onRootBack:()=>boolean})=>void;ports?:PairingPorts}){
 const [state,setState]=createSignal<PairingState>({kind:'idle'});
 const [transport,setTransport]=createSignal<PairingTransport>('internet');
 const pairing=new MiniProgramPairing(props.ports??miniProgramPairingHostPorts(),setState,transport());
 const act=(fn:()=>void)=>()=>{if(props.active())fn();};
 const close=()=>{pairing.dispose();props.onClose();};
 const cancel=()=>{if(pairing.cancel())close();};
 const back=()=>{if(isLivePairing(state()))cancel();else close();return true;};
 onCleanup(()=>pairing.dispose());
 createEffect(()=>pairing.setForeground(props.active()));
 pairing.start();

 const [now,setNow]=createSignal(Date.now());
 createEffect(()=>{
  if(state().kind!=='scan'||!props.active())return;
  let alive=true;
  const tick=()=>{if(!alive)return;setNow(Date.now());const task=delay(1000);void task.result.then(tick,()=>{});cancelTick=()=>task.cancel();};
  let cancelTick=()=>{};tick();
  onCleanup(()=>{alive=false;cancelTick();});
 });

 const measure=(text:string,slot:number)=>getOps().measureText(text,slot);
 const inner=()=>props.width-36;
 // Rounded white corners (16dp) and the quiet zone stay 2dp inside the screen circle.
 const qrTile=()=>Math.floor(Math.SQRT2*(Math.min(props.width,props.height)/2-2-16)+32);
 const qrCode=()=>qrTile()-QR_QUIET*2;
 // Text is wrapped narrower than the row so lines near the top and bottom of the face stay inside the circle.
 const TEXT_WIDTH=172;
 const text=(value:string,kind:PhoneTextKind,color?:string):ScrollEntry[]=>{
  const width=Math.min(TEXT_WIDTH,inner()),line=phonePageText(value,kind,width,measure);
  return chunkLines(line.text.split('\n'),line.lineHeight,width).map(lines=>({height:lines.length*line.lineHeight,render:()=> <Text class="absolute top-[0] text-center" style={{insetL:(inner()-width)/2,width,fontSlot:line.slot,lineHeight:line.lineHeight,textColor:color??line.color}}>{lines.join('\n')}</Text>}));
 };
 const gap=(height:number):ScrollEntry=>({height,render:()=>null});
 // Narrower than the row: these pills often sit low on the face, where the circle is tight.
 const PILL_WIDTH=140;
 const pill=(label:string,press:()=>void,primary=false):ScrollEntry=>({height:PHONE_PAGE.touchHeight,render:()=>
  <View class="absolute top-[0] rounded-[24] items-center justify-center" style={{insetL:(inner()-Math.min(PILL_WIDTH,inner()))/2,width:Math.min(PILL_WIDTH,inner()),height:PHONE_PAGE.touchHeight,bgColor:primary?PHONE_PAGE.primary:'#2a2a2a'}} focusable accessibilityRole="button" accessibilityLabel={label} onPress={act(press)}>
   <Text style={{fontSlot:22,lineHeight:21,textColor:primary?PHONE_PAGE.onPrimary:PHONE_PAGE.foreground}}>{label}</Text>
  </View>});
 // Secondary actions are text links: a second stacked pill would fall below the round edge.
 const link=(label:string,press:()=>void):ScrollEntry=>({height:40,render:()=>
  <View class="absolute top-[0] h-[40] items-center justify-center" style={{insetL:(inner()-Math.min(PILL_WIDTH,inner()))/2,width:Math.min(PILL_WIDTH,inner())}} focusable accessibilityRole="button" accessibilityLabel={label} onPress={act(press)}>
   <Text style={{fontSlot:1,lineHeight:17,textColor:PHONE_PAGE.secondary}}>{label}</Text>
  </View>});
 const spinner=(label:string):ScrollEntry=>({height:40,render:()=> <View class="absolute inset-0 items-center"><WatchProgressIndicator size={40} strokeWidth={4} color={PHONE_PAGE.primary} trackColor="#00000000" active={props.active} accessibilityLabel={label}/></View>});
 const mark=(success:boolean):ScrollEntry=>({height:40,render:()=>
  <View class="absolute top-[0] w-[40] h-[40] rounded-full items-center justify-center" style={{insetL:(inner()-40)/2,bgColor:success?PHONE_PAGE.primary:'#23272a'}}>
   {success?<Image src="../assets/icons/onboarding-check.svg" style={{width:24,height:24}}/>:<Text style={{fontSlot:23,lineHeight:26,textColor:PHONE_PAGE.foreground}}>!</Text>}
  </View>});

 const entries=createMemo<ScrollEntry[]>(()=>{
  const current=state();
  switch(current.kind){
   case 'permission':case 'idle':case 'starting':return [spinner(pairingStartingLabel(transport())),gap(12),...text(pairingStartingLabel(transport()),'body'),gap(16),pill('取消',cancel)];
   case 'scan':return [
    gap(Math.max(0,(props.height-qrTile())/2-18)),
    {height:qrTile(),render:()=> <View class="absolute top-[0] rounded-[16] bg-white" style={{insetL:(inner()-qrTile())/2,width:qrTile(),height:qrTile()}} accessibilityLabel="配对二维码">
     <View class="absolute" style={{insetL:QR_QUIET,insetT:QR_QUIET,width:qrCode(),height:qrCode()}}><FrameworkQRCode value={current.qr} size={qrCode()} pixelSize={Math.min(512,Math.max(1,Math.round(qrCode()*getDisplayMetrics().density)))} raster={pairingRaster} invalidSizeMessage="配对码生成失败" uploadErrorMessage="配对码生成失败"/></View>
    </View>},
    {height:(props.height-qrTile())/2,render:()=> <Text class="absolute left-[0] right-[0] top-[8] text-center" style={{fontSlot:0,lineHeight:14,textColor:PHONE_PAGE.secondary}}>下滑查看操作</Text>},
    ...text('用手机扫码绑定','body',PHONE_PAGE.foreground),gap(6),...text(pairingScanHint(current.transport),'body',PHONE_PAGE.secondary),gap(4),
    ...text(`${pairingCountdown(current.expiresAt-now())}，仅限本次使用`,'small'),gap(12),
    pill('取消',cancel),
   ];
   case 'confirm':{
    // The digits come from the QR secret; the account label is only what the scanner claims.
    const sas=current.sas?.length===8?`${current.sas.slice(0,4)} ${current.sas.slice(4)}`:'';
    return [
     ...text(sas?'与手机上的数字一致才绑定':'等待核对数字…','body',PHONE_PAGE.secondary),gap(4),
     ...(sas?[{height:30,render:()=> <Text class="absolute inset-0 text-center" accessibilityLabel={`核对码 ${current.sas}`} style={{fontSlot:23,lineHeight:30,textColor:PHONE_PAGE.foreground}}>{sas}</Text>} as ScrollEntry]:[]),
     gap(4),...text(`账号 ${current.account} · 确认后手表将登录`,'small'),gap(14),
     {height:48,render:()=> <View class="absolute inset-0">
      <View class="absolute w-[44] h-[44] rounded-full bg-[#23272a] items-center justify-center" style={{insetL:(inner()-156)/2,insetT:2}} focusable accessibilityRole="button" accessibilityLabel="不一致，不绑定" onPress={act(()=>pairing.confirmSas(false))}><Image src="../assets/icons/close.svg" style={{width:26,height:26}}/></View>
      <View class="absolute top-[0] w-[104] h-[48] rounded-[24] items-center justify-center" style={{insetL:(inner()-156)/2+52,bgColor:sas?PHONE_PAGE.primary:'#2a2a2a'}} focusable={!!sas} accessibilityRole="button" accessibilityState={{disabled:!sas}} accessibilityLabel="一致，绑定" onPress={sas?act(()=>pairing.confirmSas(true)):undefined}><Text style={{fontSlot:22,lineHeight:21,textColor:sas?PHONE_PAGE.onPrimary:PHONE_PAGE.secondary}}>一致，绑定</Text></View>
     </View>},
    ];
   }
   case 'working':{
    const at=PAIRING_STEPS.findIndex(item=>item.step===current.step);
    return [...text('正在设置手表','title'),gap(12),...PAIRING_STEPS.map(({label},index):ScrollEntry=>({height:28,render:()=>
     <View class="absolute top-[0] h-[28] w-[140]" style={{insetL:(inner()-140)/2}} accessibilityLabel={index<at?`${label}，已完成`:index===at?`${label}，进行中`:label}>
      {index===at?<View class="absolute left-[0] top-[4] w-[20] h-[20]"><WatchProgressIndicator size={20} strokeWidth={2.5} color={PHONE_PAGE.primary} trackColor="#00000000" active={props.active}/></View>
       :<View class="absolute left-[0] top-[4] w-[20] h-[20] rounded-full items-center justify-center" style={index<at?{bgColor:PHONE_PAGE.primary}:{bgColor:'#00000000',borderWidth:1.5,borderColor:'#5b5b5b'}}>{index<at?<Image src="../assets/icons/onboarding-check.svg" style={{width:14,height:14}}/>:null}</View>}
      <Text class="absolute left-[30] top-[3]" style={{fontSlot:22,lineHeight:21,textColor:index<=at?PHONE_PAGE.foreground:'#7a7a7a'}}>{label}</Text>
     </View>})),gap(10),...text('请保持本页打开','body',PHONE_PAGE.secondary),gap(12),pill('停止',cancel)];
   }
   case 'done':return [mark(true),gap(8),...text(pairingDoneTitle(current.cloudReady),'title'),gap(6),...text(pairingDoneDetail(current.cloudReady),'body',PHONE_PAGE.secondary),gap(14),pill('完成',()=>{pairing.dispose();(props.onDone??props.onClose)();},true)];
   case 'failed':return [...text(current.title,'title'),gap(6),...text(current.detail,'body',PHONE_PAGE.secondary),gap(14),pill('重试',()=>pairing.start(),true),gap(2),link('返回',close)];
   case 'cancelled':case 'paused':return [
    ...text(current.kind==='cancelled'?'已取消配对':'配对已暂停','title'),gap(6),
    ...text(current.kind==='cancelled'?'本次配对已结束':'离开页面后配对码已失效，需要时重新生成','body',PHONE_PAGE.secondary),gap(14),
    pill('重新开始',()=>pairing.start(),true),gap(2),link('返回',close),
   ];
  }
 });
 // Short pages sit in the middle of the round face; long ones scroll from the top.
 // Long pages scroll; generous top and bottom spacers keep their first and last rows off the narrow edge.
 const EDGE=40;
 const rows=createMemo(()=>{const list=entries();if(state().kind==='scan')return [...list,gap(EDGE)];const room=props.height-36-list.reduce((sum,row)=>sum+row.height,0);return room>=EDGE*2?[gap(room/2),...list]:[gap(EDGE),...list,gap(EDGE)];});
 return <View class="absolute inset-0 bg-black"><ScrollEntries round={null} height={props.height} entries={rows()} padding={18} gap={0} inputActive={props.active} ref={value=>props.ref({...value,onRootBack:back})} accessibilityLabel="扫码绑定"/></View>;
}
