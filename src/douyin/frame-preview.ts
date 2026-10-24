import type {VideoFrame,VideoFrameSource} from '@podjs/framework/services';
/** A rendered picture is only a preview, never a grant to play a saved URL. */
export interface DouyinFramePreview {entryId:string;frame:VideoFrame}
export function framePreviewPath(preview:DouyinFramePreview|undefined,entryId:string|undefined){return preview&&preview.entryId===entryId&&preview.frame.kind==='actual_frame'?preview.frame.path:undefined;}
export function frameSource(source:VideoFrameSource):VideoFrameSource{return {url:source.url,videoUrl:source.videoUrl,audioUrl:source.audioUrl,headers:source.headers};}
