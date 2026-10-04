import type {JsonObject} from './protocol.ts';
import {ReaderPreviewSession} from '../reader/preview-session.ts';
import {decodeReaderPreset} from '../reader/preset.ts';
import {wireFields} from './article-batches.ts';
import {tokenUsageOptInt} from './token-usage.ts';
import {readerRequiredLong,readerRequiredString} from './reader-manifest.ts';
export function handleReaderPreview(request:JsonObject,session:ReaderPreviewSession,open:()=>void):JsonObject {
 const version=tokenUsageOptInt(request,'version',0);if(version<1||version>2)throw Error('不支持的阅读器实时预览版本');
 const sessionId=wireFields.trim(request.sessionId===undefined?'':wireFields.string(request.sessionId));if(!sessionId)throw Error('缺少预览会话 ID');
 const phase=request.phase===undefined?'':wireFields.string(request.phase),response:JsonObject={success:true,action:'previewReader',phase,sessionId};
 if(phase==='update'||phase==='resourceHandoff'){
  const sequence=readerRequiredLong(request,'sequence'),transfer=phase==='resourceHandoff'||wireFields.bool(request.resourceTransfer);let applied:boolean;
  if(Object.hasOwn(request,'preset')){const preset=wireFields.object(request.preset);if(!preset)throw Error('无效预设对象 preset');applied=session.update(sessionId,sequence,decodeReaderPreset(preset),transfer);}
  else if(Object.hasOwn(request,'changes')){const changes=wireFields.object(request.changes);if(!changes)throw Error('无效预设对象 changes');applied=session.updateDelta(sessionId,sequence,changes,transfer);}
  else applied=session.update(sessionId,sequence,decodeReaderPreset(readerRequiredString(request,'presetJson')),transfer);
  if(phase==='update'&&applied)open();return {...response,sequence,applied};
 }
 if(phase==='heartbeat'){const sequence=wireFields.optLong(request.sequence,0),appliedSequence=session.heartbeat(sessionId,sequence);return {...response,sequence,...(appliedSequence===null?{}:{appliedSequence})};}
 if(phase==='stop')return {...response,applied:session.stop(sessionId)};
 throw Error('未知的阅读器实时预览阶段');
}
