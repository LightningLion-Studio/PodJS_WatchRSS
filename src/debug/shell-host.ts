import {libraryDiagnostics,syncHistory} from './sync-diagnostics-host';
import {registerShellCommands,shellDiagnostics,ShellCommandError,type ShellContext} from '@podjs/framework/shell';
import {delay} from '@podjs/framework/services';
import type {DouyinClient} from '../douyin/client.ts';
import type {DouyinPlayRequest,DouyinRoute} from '../ui/douyin/index.tsx';
import type {RouteEntry} from '../ui/routes/types.ts';
import type {PlaybackSource} from '../ui/VideoPlayerScreen.tsx';
import {createShellHandlers} from './shell-commands.ts';

export function bindShellCommands(port:{current():RouteEntry;client:DouyinClient;navigate(route:DouyinRoute):Promise<void>;play(request:DouyinPlayRequest):void;move(entry:RouteEntry,direction:'next'|'previous',isCurrent?:()=>boolean):Promise<void>}) {
 let lastTarget:string|undefined,targetOrdinal=0;
 const check=(context:ShellContext)=>{if(!context.isActive())throw new ShellCommandError('unavailable');};
 const player=()=>{const entry=port.current();if(entry.page!=='video'||entry.playback?.platform!=='douyin'||!entry.player?.shellState||!entry.player.shellPlaying)throw new ShellCommandError('not_ready');return entry.player as typeof entry.player & {shellState:NonNullable<typeof entry.player.shellState>;shellPlaying:NonNullable<typeof entry.player.shellPlaying>};};
 const wait=async(context:ShellContext,entry:RouteEntry,owned:()=>PlaybackSource|undefined,target:string,active:()=>boolean=()=>true)=>{
  const selected=()=>{
   check(context);
   const source=owned();
   if(!active()||port.current()!==entry||entry.page!=='video'||!source||entry.playback!==source||source.awemeId!==target)throw new ShellCommandError('unavailable');
   return source;
  };
  for(let n=0;n<200;n++){
   const source=selected();
   try{
    if(!source.previewOnly){
     const value=await player().shellState();
     if(selected()!==source)continue;
     if(value.state==='error')throw new ShellCommandError('unavailable');
     if(value.state==='playing')return;
    }
   }catch(error){if(!(error instanceof ShellCommandError)||error.code!=='not_ready')throw error;}
   await delay(50).result;
  }
  throw new ShellCommandError('not_ready');
 };
 return registerShellCommands(createShellHandlers({
  page:()=>{const entry=port.current();return entry.page==='douyin'?`douyin.${entry.douyinRoute?.name??'entry'}`:entry.page;},
  open:async context=>{check(context);await port.navigate({name:'entry'});},
  play:async(target,context)=>{
   const origin=port.current(),snapshot=origin.queue?.snapshot();
   const restored=snapshot?undefined:await port.client.restoreFeed();
   const fresh=restored&&port.client.freshPlaybackSnapshot(restored);
   let items=snapshot?.playlist??fresh!.items,cursor=snapshot?snapshot.cursor:fresh?.cursor,hasMore=snapshot?snapshot.hasMore:fresh?.hasMore;
   check(context);if(port.current()!==origin)throw new ShellCommandError('unavailable');
   if(target.index!==undefined&&!items[target.index]){
    const result=await port.client.fetchFeedPage({count:20});check(context);
    if(!result.ok)throw new ShellCommandError('unavailable');items=result.data.items;cursor=result.data.nextCursor;hasMore=result.data.hasMore;
   }
   let item=target.awemeId?items.find(item=>item.awemeId===target.awemeId):items[target.index!];
   if(!item&&target.awemeId){const result=await port.client.resolvePlayback(target.awemeId);check(context);if(!result.ok)throw new ShellCommandError('not_found');item=result.data;items=[item];}
   if(!item)throw new ShellCommandError('not_found');
   check(context);if(port.current()!==origin)throw new ShellCommandError('unavailable');
   let valid=true,failed=false,source:PlaybackSource|undefined;
   const active=()=>valid&&!failed&&context.isActive();
   try{
    port.play({item,playback:item,playlist:items,cursor:cursor??undefined,hasMore:hasMore??false,immersive:true,isCurrent:active,
     onSourcePublished:value=>{source=value;},onSourceFailure:()=>{failed=true;},onFailure:()=>{failed=true;}});
    await port.navigate({name:'player',awemeId:item.awemeId});
    const entry=port.current();
    check(context);
    if(entry===origin||!source||failed)throw new ShellCommandError('unavailable');
    await wait(context,entry,()=>source,item.awemeId,active);
   }finally{valid=false;}
  },
  playing:playing=>player().shellPlaying(playing),
  move:async(direction,context)=>{
   player();check(context);const entry=port.current(),snapshot=entry.queue?.snapshot();
   if(!snapshot||direction==='previous'&&snapshot.index===0)throw new ShellCommandError('not_found');
   const before=entry.playback?.awemeId;
   await port.move(entry,direction,context.isActive);check(context);
   if(port.current()!==entry)throw new ShellCommandError('unavailable');
   if(entry.playback?.awemeId===before)throw new ShellCommandError('not_found');
   const source=entry.playback;
   if(!source?.awemeId)throw new ShellCommandError('unavailable');
   await wait(context,entry,()=>source,source.awemeId);
  },
  state:async()=>{const entry=port.current();if(entry.page!=='video'||entry.playback?.platform!=='douyin')return null;
   const source=entry.playback,target=source.awemeId;if(target!==lastTarget){lastTarget=target;targetOrdinal++;}
   const ordinal=targetOrdinal;
   try{const value=await player().shellState();if(port.current()!==entry||entry.playback!==source)throw new ShellCommandError('unavailable');return {...value,targetOrdinal:ordinal};}catch(error){if(error instanceof ShellCommandError&&error.code==='not_ready'){if(port.current()!==entry||entry.playback!==source)throw new ShellCommandError('unavailable');return {state:'preparing',positionMs:0,targetOrdinal:ordinal,reloadCount:entry.player?.reloadAttempts?.()??0};}throw error;}},
  diagnostics:shellDiagnostics,
 },{books:(check,page)=>libraryDiagnostics.books(check,page),summary:check=>libraryDiagnostics.summary(check),last:n=>syncHistory.last(n)}));
}
