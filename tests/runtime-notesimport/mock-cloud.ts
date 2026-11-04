import {fixture} from '../cloud/service-fixture';
import {readWrss} from '../../src/cloud/wrss';
import {crypto} from '../cloud/k2-crypto';
import {utf8Encode} from '../../src/cloud/types';
const out=process.env.NOTESIMPORT_EVIDENCE!;
const f=await fixture();
const archive=new Uint8Array(await Bun.file(new URL('../cloud/fixtures/notesimport/mini-image-assets.zip',import.meta.url)).arrayBuffer());
const entries=await readWrss(archive,crypto.gunzip),image=[...entries.keys()].find(k=>k.startsWith('notes/assets/'))!.slice(13);
const oracle=await Bun.file(new URL('../cloud/fixtures/notesimport/phone-vectors.json',import.meta.url)).json(),base=oracle.phoneState.notes.find((n:any)=>!n.deleted);
const notes=[{...base,id:'fixture-cloud-text',title:'云端备忘录',markdown:'手机和小程序的云同步内容',pinned:true},{...base,id:'fixture-cloud-image',title:'云端图片',markdown:`![图片](assets/${image})`,pinned:false},{...base,id:'fixture-deleted',title:'已删除',deleted:true,deletedAt:200}];
for(const n of notes)n.hash=await crypto.sha256(utf8Encode(n.markdown));
const bytes=utf8Encode(JSON.stringify({format:'watchrss-notes',version:1,notes}));await Bun.write(out+'/emulator-notes-state.json',bytes);
await f.phone({objects:[{name:'notes-state.json',bytes},{name:'notes-assets.zip',bytes:archive}]});
const server=Bun.serve({hostname:'127.0.0.1',port:18788,async fetch(req){
 const u=new URL(req.url);if(u.pathname==='/proof')return Response.json({heads:[...f.heads.values()],calls:f.calls.map(c=>({url:c.url,method:c.method})),reservations:f.reservations.size});
 const object=u.pathname.startsWith('/objects/'),path=object?u.pathname.slice('/objects'.length):u.pathname;
 const r=await f.transport.request({url:'https://'+(object?'objects.invalid':'backend.invalid')+path+u.search,method:req.method,headers:object?{}:Object.fromEntries(req.headers),body:req.method==='GET'||req.method==='HEAD'?undefined:new Uint8Array(await req.arrayBuffer())});
 console.log(JSON.stringify({event:'mock-request',method:req.method,path,status:r.status}));return new Response(r.body.slice().buffer as ArrayBuffer,{status:r.status,headers:r.headers});
}});console.log(JSON.stringify({event:'mock-ready',port:server.port,notes:notes.length,image}));
