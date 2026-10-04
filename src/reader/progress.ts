import type { KeyValueStore, ReadingProgress } from "./types";
const finite=(value:unknown,fallback=0)=>typeof value==="number"&&Number.isFinite(value)?value:fallback;
export const normalizeReadingProgress=(value:Partial<ReadingProgress>):ReadingProgress=>({
  offset:Math.max(0,finite(value.offset)),progress:Math.min(1,Math.max(0,finite(value.progress))),updatedAt:Math.max(0,finite(value.updatedAt)),
  ...(value.importedAnchor&&typeof value.importedAnchor.marker==="string"&&Number.isSafeInteger(value.importedAnchor.chunkIndex)&&value.importedAnchor.chunkIndex>=0&&Number.isSafeInteger(value.importedAnchor.charOffset)&&value.importedAnchor.charOffset>=0&&Number.isFinite(value.importedAnchor.fraction)?{importedAnchor:{marker:value.importedAnchor.marker,chunkIndex:value.importedAnchor.chunkIndex,charOffset:value.importedAnchor.charOffset,fraction:Math.max(0,Math.min(.999,value.importedAnchor.fraction)),...((value.importedAnchor.section==="header"||value.importedAnchor.section==="footer")&&Number.isFinite(value.importedAnchor.sectionOffset)&&value.importedAnchor.sectionOffset!>=0?{section:value.importedAnchor.section,sectionOffset:value.importedAnchor.sectionOffset}:{})}}:{}),
  ...(value.textAnchor&&Number.isFinite(value.textAnchor.character)&&value.textAnchor.character>=0&&Number.isFinite(value.textAnchor.fraction)?{textAnchor:{character:value.textAnchor.character,fraction:Math.max(0,Math.min(.999,value.textAnchor.fraction)),...(Number.isInteger(value.textAnchor.mediaIndex)&&value.textAnchor.mediaIndex!>=0?{mediaIndex:value.textAnchor.mediaIndex}:{}),...((value.textAnchor.section==="header"||value.textAnchor.section==="footer")&&Number.isFinite(value.textAnchor.sectionOffset)&&value.textAnchor.sectionOffset!>=0?{section:value.textAnchor.section,sectionOffset:value.textAnchor.sectionOffset}:{})}}:{}),
});
export class ReadingProgressStore {
  constructor(private readonly kv:KeyValueStore,private readonly prefix="watchrss.reader.progress."){}
  async load(articleId:number):Promise<ReadingProgress>{
    const raw=await this.kv.get(this.prefix+articleId);
    try{const value=raw?JSON.parse(raw):{};return normalizeReadingProgress(value&&typeof value==="object"?value:{});}catch{return normalizeReadingProgress({});}
  }
  async save(articleId:number,offset:number,progress:number,textAnchor?:ReadingProgress["textAnchor"],importedAnchor?:ReadingProgress["importedAnchor"]):Promise<void>{
    await this.kv.set(this.prefix+articleId,JSON.stringify(normalizeReadingProgress({offset,progress,updatedAt:Date.now(),textAnchor,importedAnchor})));
  }
}
