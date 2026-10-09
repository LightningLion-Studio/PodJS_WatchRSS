import {debugLogBuffer} from '../debug/log-buffer.ts';
import {kv} from '@podjs/framework/watch';
import {fileChunks} from '@podjs/framework/services';
import {createHostLogFile as frameworkLogFile} from '@podjs/framework/log-file';
import {AppLogger,APP_LOG_FILE,installAppLogger,appLogger,type LogFile} from './app-logger.ts';

/** Application storage names, chunk preset and error copy. */
export function createHostLogFile(files=fileChunks):LogFile {
 return frameworkLogFile({path:APP_LOG_FILE,temporaryDirectory:'logs',chunkBytes:65536,messages:{write:'日志写入不完整',read:'日志读取不完整'}},files);
}
export const hostAppLogger=new AppLogger(createHostLogFile(),()=>new Date(),(level,line)=>{
 debugLogBuffer.append(line);
 if(level==='E')console.error(line);else if(level==='W')console.warn(line);else console.info(line);
});
let started=false;
export function startAppLogger(deferInit?:Promise<void>){
 if(started)return;started=true;installAppLogger(hostAppLogger);
 const launched=new Date(),pad=(n:number)=>String(n).padStart(2,"0");
 appLogger.d("Application",`应用启动 - ${launched.getFullYear()}-${pad(launched.getMonth()+1)}-${pad(launched.getDate())} ${pad(launched.getHours())}:${pad(launched.getMinutes())}:${pad(launched.getSeconds())}`);
 let legacy:string|undefined;try{legacy=kv.get<string>('watchrss.sync.diagnostics.v1');}catch{}
 // The full-file redaction scan reads the whole log (hundreds of KB through file.read);
 // run it after the first screen so it never delays startup. Appends still work meanwhile.
 // One full-file redaction scan migrates logs from builds that did not redact per line; it is
 // regex-heavy over hundreds of KB, so remember it and never repeat it on later starts.
 const flag='watchrss.applog.redacted.v1';let scanned=false;try{scanned=kv.get<boolean>(flag)===true;}catch{}
 void (deferInit??Promise.resolve()).then(()=>hostAppLogger.init(legacy,!scanned)).then(()=>{if(!scanned)try{kv.set(flag,true);}catch{}}).catch(()=>{});
}
