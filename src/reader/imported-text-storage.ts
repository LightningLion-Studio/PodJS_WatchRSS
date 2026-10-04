import {fileChunks,bytesToBase64} from "@podjs/framework/services";
import {ImportedTextWriter} from "./imported-text-writer.ts";
/** Durable host adapter shared by imported content and phone synchronization. */
export const importedTextWriter=new ImportedTextWriter({
  createTemp:directory=>fileChunks.createTemp(directory),
  write:(path,bytes)=>fileChunks.write(path,bytesToBase64(bytes)),
  append:(path,bytes,offset)=>fileChunks.append(path,bytesToBase64(bytes),offset),
  hash:path=>fileChunks.hash(path),
  commit:(path,target,size,hash)=>fileChunks.commit(path,target,size,hash),
  remove:path=>fileChunks.remove(path),
});
