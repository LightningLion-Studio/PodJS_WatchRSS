import {kv} from '@podjs/framework/watch';
import {fileChunks} from '@podjs/framework/services';
import {base64ToBytes,bytesToBase64,stringToUtf8,utf8ToString} from '@podjs/framework/bytes';
import {AppLogger,APP_LOG_FILE,installAppLogger,type LogFile} from './app-logger.ts';

/** All transfers stay under the host's 64 KiB bridge chunk limit. */
export function createHostLogFile(files= fileChunks):LogFile {
 const append=async(path:string,text:string,offset:number)=>{
  const bytes=stringToUtf8(text);
  for(let start=0;start<bytes.length;start+=65536){const part=bytes.subarray(start,start+65536);const result=await files.append(path,bytesToBase64(part),offset+start);if(result.size!==offset+start+part.length)throw Error('日志写入不完整');}
 };
 return {
  async size(){const stat=await files.stat(APP_LOG_FILE);return stat.exists?stat.size:0;},
  async read(){
   const stat=await files.stat(APP_LOG_FILE);if(!stat.exists||!stat.size)return null;
   const bytes=new Uint8Array(stat.size);
   for(let offset=0;offset<bytes.length;){const chunk=await files.read(APP_LOG_FILE,offset,Math.min(65536,bytes.length-offset));const part=base64ToBytes(chunk.dataBase64);if(chunk.offset!==offset||chunk.size!==bytes.length||!part.length||part.length>bytes.length-offset)throw Error('日志读取不完整');bytes.set(part,offset);offset+=part.length;}
   return utf8ToString(bytes);
  },
  async replace(text){
   const temp=await files.createTemp('logs');
   try{await append(temp.path,text,0);const hash=await files.hash(temp.path);await files.commit(temp.path,APP_LOG_FILE,hash.size,hash.sha256);}
   finally{await files.remove(temp.path).catch(()=>{});}
  },
  async append(text,offset){if(offset===0&&!(await files.stat(APP_LOG_FILE)).exists)await files.write(APP_LOG_FILE,'');await append(APP_LOG_FILE,text,offset);},
 };
}
export const hostAppLogger=new AppLogger(createHostLogFile(),()=>new Date(),(level,line)=>{
 if(level==='E')console.error(line);else if(level==='W')console.warn(line);else console.info(line);
});
let started=false;
export function startAppLogger(){
 if(started)return;started=true;installAppLogger(hostAppLogger);
 let legacy:string|undefined;try{legacy=kv.get<string>('watchrss.sync.diagnostics.v1');}catch{}
 void hostAppLogger.init(legacy).catch(()=>{});
}
