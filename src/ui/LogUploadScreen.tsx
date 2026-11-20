import {useNetworkRecovery} from '../network/context.ts';
import {Text,View} from '@pocketjs/framework/components';
import {createSignal,onCleanup,onMount,Show} from 'solid-js';
import {LogUploadController,type LogUploadOptions,type LogUploadState} from '../logs/upload.ts';
import {ScrollEntries,type ScrollEntry} from './ScrollEntries.tsx';
import {logTextEntries} from './log-text-entries.tsx';
import {DeleteConfirmDialog} from './DeleteConfirmDialog.tsx';

/** Standalone: lead owns privacy-screen callback and route wiring.
 * options are explicit so mounting a fixture cannot accidentally contact production. */
export function LogUploadScreen(props:{height:number;width:number;options:LogUploadOptions;autoStart:boolean;consumeConsent:()=>void;active?:()=>boolean;onManage:()=>void;onRetry:()=>void}) {
  const network=useNetworkRecovery();
  const [state,setState]=createSignal<LogUploadState>({phase:'loading',message:'加载中...'});
  const [confirmDelete,setConfirmDelete]=createSignal(false);
  const [deleting,setDeleting]=createSignal(false);
  const [deleteError,setDeleteError]=createSignal('');
  const controller=new LogUploadController({...props.options,backend:{...props.options.backend,upload:(...args)=>network.run(()=>props.options.backend.upload(...args)),delete:(...args)=>props.options.backend.delete(...args)}},setState);
  onMount(()=>{const consented=props.autoStart;props.consumeConsent();if(!consented)setState({phase:'empty',message:'请先阅读日志说明并再次同意，本页不会自动重新上传。'});void controller.start(consented);});
  onCleanup(()=>controller.dispose());
  const padding=24;
  const textRows=(text:string,height=52)=>logTextEntries(text,props.width-2*padding,height);
  const button=(label:string,onPress:()=>void):ScrollEntry=>({
    height:52,
    render:()=> <View onPress={onPress} focusable accessibilityRole="button" accessibilityLabel={label}
      class="absolute inset-0 items-center justify-center rounded-[30] bg-[#2a2a2a] active:scale-96">
      <Text class="text-base leading-[22] text-[#f5f5f5]">{label}</Text>
    </View>,
  });
  const removeCurrent=async()=>{
    const current=state();if(current.phase!=='success'||deleting())return;
    setDeleting(true);setDeleteError('');
    try {await props.options.backend.delete(current.receipt.id,current.receipt.deleteToken);if(current.receiptSaved)await props.options.receipts.remove(current.receipt.id);setState({phase:'empty',message:'已删除这份日志'});}
    catch(error){setDeleteError(error instanceof Error?error.message:String(error));}
    finally{setDeleting(false);setConfirmDelete(false);}
  };
  const entries=():ScrollEntry[]=>{
    const s=state();
    const rows=[...textRows('日志上传',40),...textRows(s.message,84)];
    if(s.phase==='success'){
      const receipt=s.receipt;
      rows.push(
        ...textRows(`取件码：${receipt.code}`),
        ...textRows(`上传时间：${receipt.createdAt}`,68),
        ...textRows(`自动删除：${receipt.expiresAt}`,68),
        ...textRows(`密文：${receipt.fileSize} B · ${receipt.charCount} 字符`,55),
      );
      if(deleteError())rows.push(...textRows(`删除失败：${deleteError()}`,75));
      rows.push(button(deleting()?'正在删除…':'立即删除这份日志',()=>setConfirmDelete(true)));
    } else if(s.phase==='upload-error'||s.phase==='load-error'){
      rows.push(button('重试上传',props.onRetry));
    }
    rows.push(button('管理已上传日志',props.onManage));
    return rows;
  };
  return <><ScrollEntries height={props.height} entries={entries()} padding={padding} inputActive={()=>!confirmDelete()&&!deleting()&&(props.active?.()??true)} accessibilityLabel="日志上传"/><Show when={confirmDelete()}><DeleteConfirmDialog width={props.width} height={props.height} title="删除已上传日志" message="确认从服务器删除这份加密日志？删除后不可恢复。" busy={deleting()} onCancel={()=>setConfirmDelete(false)} onConfirm={()=>void removeCurrent()}/></Show></>;
}
