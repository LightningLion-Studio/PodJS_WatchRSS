import {randomBytes} from 'node:crypto';
import {createServer,connect,type Socket} from 'node:net';

const prefix='WRSS-LOOPBACK-1 ';
const timeoutMs=10_000;

// Test-only pairing. Foreign clients never consume a pending accept or reach
// production framing. Keep admitted sockets paused until framing owns reads.
export async function pairedLoopback() {
 const sockets=new Set<Socket>();
 const pending=new Map<string,{resolve:(socket:Socket)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 const server=createServer(socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
  socket.on('error',()=>{});
  let header=Buffer.alloc(0);
  const timer=setTimeout(()=>socket.destroy(),timeoutMs);timer.unref();
  socket.once('close',()=>clearTimeout(timer));
  const read=(bytes:Buffer)=>{
   header=Buffer.concat([header,bytes]);
   const end=header.indexOf(10);
   const line=end<0?header:header.subarray(0,end);
   if(line.length>prefix.length+64||!line.subarray(0,prefix.length).equals(Buffer.from(prefix).subarray(0,Math.min(line.length,prefix.length)))){socket.destroy();return;}
   if(end<0)return;
   const token=line.subarray(prefix.length).toString('ascii');
   const waiter=pending.get(token);
   if(!waiter){socket.destroy();return;}
   socket.pause();socket.off('data',read);clearTimeout(timer);
   pending.delete(token);clearTimeout(waiter.timer);
   if(header.length>end+1)socket.unshift(header.subarray(end+1));
   waiter.resolve(socket);
  };
  socket.on('data',read);
 });
 await new Promise<void>((resolve,reject)=>{
  server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
 });
 const port=(server.address() as {port:number}).port;
 const accept=(token:string)=>{
  if(pending.has(token))throw new Error('duplicate loopback token');
  return new Promise<Socket>((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(token);reject(new Error('loopback pairing timed out'));},timeoutMs);
   pending.set(token,{resolve,reject,timer});
  });
 };
 const dial=()=>{
  const socket=connect({host:'127.0.0.1',port});sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});return socket;
 };
 const client=async(token:string)=>{
  const socket=dial();
  await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.once('connect',()=>{socket.off('error',reject);resolve();});});
  socket.write(prefix+token+'\n');return socket;
 };
 return {port,accept,client,dial,async pair(){
  const token=randomBytes(32).toString('hex');const accepted=accept(token);
  try {const socket=await client(token);return {socket,remote:await accepted};}
  catch(error){const waiter=pending.get(token);if(waiter){pending.delete(token);clearTimeout(waiter.timer);waiter.reject(error as Error);}await accepted.catch(()=>{});throw error;}
 },async close(){
  for(const waiter of pending.values()){clearTimeout(waiter.timer);waiter.reject(new Error('loopback closed'));}pending.clear();
  for(const socket of sockets)socket.destroy();
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 }};
}
