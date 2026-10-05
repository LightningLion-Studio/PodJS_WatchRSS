import {utf8ToString} from '@podjs/framework/bytes';
import type {HttpTransport} from '../cloud/types.ts';
import {LOG_API,LOG_APP_ID,LOG_SOCKET} from './constants.ts';
import type {LogBackend} from './upload.ts';

export interface LogSocket {send(message:Record<string,unknown>):Promise<void>;read():Promise<unknown>;close():Promise<unknown>}
export interface InstantLogPorts {http:HttpTransport;connect(url:string):Promise<LogSocket>;uuid():Promise<string>}
type Attr={id:string;'forward-identity':string[];'reverse-identity'?:string[]};
/** Native SDK v0.22.146's upload + update/link wire protocol. No admin API/token. */
export function createInstantLogBackend(ports:InstantLogPorts,auth?:{id:string;refreshToken:string}):LogBackend {
  return {
    async upload(path,bytes) {
      const response=await ports.http.request({method:'PUT',url:`${LOG_API}/storage/upload`,headers:{app_id:LOG_APP_ID,path,authorization:`Bearer ${auth?.refreshToken}`, 'content-type':'application/octet-stream'},body:bytes});
      if(response.status<200||response.status>=300)throw Error(`文件上传失败：HTTP ${response.status}`);
      const body=JSON.parse(utf8ToString(response.body));
      if(typeof body?.data?.id!=='string'||!body.data.id)throw Error('上传响应缺少文件 ID');
      return body.data.id;
    },
    async save(id,record,fileId) {
      const socket=await ports.connect(`${LOG_SOCKET}?app_id=${LOG_APP_ID}`);
      try {
        const initId=await ports.uuid();
        await socket.send({op:'init','app-id':LOG_APP_ID,...(auth?{'refresh-token':auth.refreshToken}:{}),versions:{'@instantdb/core':'v0.22.146','@instantdb/react':'v0.22.146'},'client-event-id':initId});
        const queue:unknown[]=[];
        const receive=async(op:string,eventId:string):Promise<Record<string,unknown>>=>{
          // Host reads have a timeout; frame bound also prevents unsolicited traffic
          // from keeping a save alive indefinitely. Batched SDK messages are legal.
          for(let n=0;n<64;n++) {
            if(!queue.length){const frame=await socket.read();queue.push(...(Array.isArray(frame)?frame:[frame]));}
            const message=queue.shift() as Record<string,unknown>|null;
            if(!message||typeof message!=='object')throw Error('日志服务响应无效');
            if(message.op==='error')throw Error('日志服务拒绝请求');
            if(message.op===op&&message['client-event-id']===eventId)return message;
          }
          throw Error('日志服务响应超时');
        };
        const init=await receive('init-ok',initId);
        if(!Array.isArray(init.attrs))throw Error('日志服务缺少字段定义');
        const attrs=init.attrs as Attr[];
        const steps:unknown[][]=[];
        const attr=async(name:string)=>{
          const found=attrs.find(a=>a?.['forward-identity']?.[1]==='logs'&&a['forward-identity'][2]===name);
          if(found)return found.id;
          // Same schema-inferred add-attr as the bundled SDK on a fresh database.
          const attrId=await ports.uuid(),identity=await ports.uuid();
          const link=name==='encryptedFile';
          steps.push(['add-attr',{id:attrId,'forward-identity':[identity,'logs',name],'value-type':link?'ref':'blob',cardinality:'one','unique?':name==='id'||link,'index?':['code','createdAt','userId'].includes(name),
            ...(link?{'reverse-identity':[await ports.uuid(),'$files','log']} : name==='id'?{}:{'checked-data-type':['fileSize','charCount'].includes(name)?'number':'string'})}]);
          return attrId;
        };
        // SDK update writes fields and the implicit entity ID, then link writes the ref.
        steps.push(['add-triple',id,await attr('id'),id]);
        for(const [name,value] of Object.entries(record))steps.push(['add-triple',id,await attr(name),value]);
        const reverse=attrs.find(a=>a?.['reverse-identity']?.[1]==='logs'&&a['reverse-identity'][2]==='encryptedFile');
        steps.push(reverse?['add-triple',fileId,reverse.id,id]:['add-triple',id,await attr('encryptedFile'),fileId]);
        const eventId=await ports.uuid();
        await socket.send({op:'transact','tx-steps':[...steps.filter(s=>s[0]==='add-attr'),...steps.filter(s=>s[0]!=='add-attr')],'client-event-id':eventId,created:Date.now(),order:1});
        await receive('transact-ok',eventId);
      } finally {await socket.close().catch(()=>{});}
    },
  };
}
