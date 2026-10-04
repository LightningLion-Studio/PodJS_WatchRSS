import type { SpeechProgress } from "./speech-highlight.ts";
export interface SpeechPort {
  initialize(): Promise<unknown>;
  speak(text:string, rate:number, utteranceId?:string): Promise<unknown>;
  onProgress?(listener:(event:{type:string;utteranceId:string;start?:number;end?:number;elapsedMs?:number})=>void):()=>void;
  state(): Promise<{state:string}>;
  stop(): Promise<unknown>;
}
// Android engines accept at most 4000 UTF-16 units. Leave room for engine-specific limits.
export function speechChunks(text:string, limit=3000): string[] {
  if(limit<2)throw new Error("Speech chunk limit must be at least two");
  const chunks:string[]=[];
  for(let offset=0;offset<text.length;){
    let end=Math.min(text.length,offset+limit);
    if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1]!))end--;
    if(end<text.length){const boundary=text.slice(offset,end).search(/[。！？.!?\n][^。！？.!?\n]*$/);if(boundary>=limit/2)end=offset+boundary+1;}
    chunks.push(text.slice(offset,end));offset=end;
  }
  return chunks;
}
export class ReaderSpeech {
  private generation=0;
  constructor(private readonly port:SpeechPort,private readonly wait=()=>new Promise<void>(resolve=>setTimeout(resolve,200))){}
  async speak(text:string,rate=1,started?:()=>void,progress?:(event:SpeechProgress)=>void):Promise<void>{
    const generation=++this.generation;
    if(!text.trim())return;
    await this.port.initialize();
    let chunkOffset=0;
    for(const chunk of speechChunks(text)){
      if(generation!==this.generation)return;
      const utteranceId=`reader-${generation}-${chunkOffset}`;
      const remove=this.port.onProgress?.(event=>{
        if(generation!==this.generation||event.utteranceId!==utteranceId)return;
        if(event.type==="range"&&Number.isInteger(event.start)&&Number.isInteger(event.end))progress?.({type:"range",start:chunkOffset+event.start!,end:chunkOffset+event.end!});
        else if(event.type==="start"||event.type==="done"||event.type==="stop")progress?.({type:event.type,elapsedMs:event.elapsedMs});
      });
      try {
      await this.port.speak(chunk,rate,utteranceId);
      if(generation===this.generation)started?.();
      while(generation===this.generation){
        await this.wait();
        if(generation!==this.generation)return;
        const state=await this.port.state();
        if(generation!==this.generation)return;
        if(state.state==="ready")break;
        if(state.state!=="speaking")throw new Error("朗读引擎未能完成当前段落");
      }
      } finally {remove?.();}
      chunkOffset+=chunk.length;
    }
  }
  async stop():Promise<void>{this.generation++;await this.port.stop();}
}
