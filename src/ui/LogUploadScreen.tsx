import {Text,View} from '@pocketjs/framework/components';
import {createSignal,onCleanup,onMount,Show} from 'solid-js';
import {LogUploadController,type LogUploadOptions,type LogUploadState} from '../logs/upload.ts';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import {DeleteConfirmDialog} from './DeleteConfirmDialog.tsx';

/** Standalone: lead owns privacy-screen callback and route wiring.
 * options are explicit so mounting a fixture cannot accidentally contact production. */
export function LogUploadScreen(props:{height:number;width:number;options:LogUploadOptions;autoStart:boolean;consumeConsent:()=>void;active?:()=>boolean;onManage:()=>void}) {
  const [state,setState]=createSignal<LogUploadState>({phase:'loading',message:'加载中...'});
  const [confirmDelete,setConfirmDelete]=createSignal(false);
  const [deleting,setDeleting]=createSignal(false);
  const [deleteError,setDeleteError]=createSignal('');
  const controller=new LogUploadController(props.options,setState);
  onMount(()=>{const consented=props.autoStart;props.consumeConsent();if(!consented)setState({phase:'empty',message:'请先阅读日志说明并再次同意，本页不会自动重新上传。'});void controller.start(consented);});
  onCleanup(()=>controller.dispose());
  const row=(text:string,height=52,onPress?:()=>void):ScrollEntry=>({height,render:()=> <View onPress={onPress} focusable={!!onPress} class={onPress?'absolute inset-0 items-center justify-center rounded-[30] bg-[#2a2a2a] active:scale-96':'absolute inset-0 items-center justify-center'}><Text class="text-base leading-[22] text-[#f5f5f5]">{text}</Text></View>});
  const removeCurrent=async()=>{
    const current=state();if(current.phase!=='success'||deleting())return;
    setDeleting(true);setDeleteError('');
    try {await props.options.backend.delete(current.receipt.id,current.receipt.deleteToken);if(current.receiptSaved)await props.options.receipts.remove(current.receipt.id);setState({phase:'empty',message:'已删除这份日志'});}
    catch(error){setDeleteError(error instanceof Error?error.message:String(error));}
    finally{setDeleting(false);setConfirmDelete(false);}
  };
  const entries=():ScrollEntry[]=>{
    const s=state();
    return [row('日志上传',40),row(s.message,84),...(s.phase==='success'?[row(`取件码：${s.receipt.code}`),row(`上传时间：${s.receipt.createdAt}`,68),row(`自动删除：${s.receipt.expiresAt}`,68),row(`密文：${s.receipt.fileSize} B · ${s.receipt.charCount} 字符`,55),...(deleteError()?[row(`删除失败：${deleteError()}`,75)]:[]),row(deleting()?'正在删除…':'立即删除这份日志',52,()=>setConfirmDelete(true)),row('管理已上传日志',52,props.onManage)]:[row('管理已上传日志',52,props.onManage)])];
  };
  return <><ScrollEntries height={props.height} entries={entries()} padding={24} inputActive={()=>!confirmDelete()&&!deleting()&&(props.active?.()??true)} accessibilityLabel="日志上传"/><Show when={confirmDelete()}><DeleteConfirmDialog width={props.width} height={props.height} title="删除已上传日志" message="确认从服务器删除这份加密日志？删除后不可恢复。" busy={deleting()} onCancel={()=>setConfirmDelete(false)} onConfirm={()=>void removeCurrent()}/></Show></>;
}
