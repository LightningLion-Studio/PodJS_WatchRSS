import {frameworkRoot} from '../framework-path';
/** Offline refresh-all replay. Read-only local snapshot supplies real body/row
 * shapes; reconstructed RSS/Atom is explicitly not an upstream capture. Bun
 * executes the production repository SQL against a private SQLite copy; QuickJS
 * replays those exact calls/results and validates every transaction statement.
 * No network or device access. Fixture content remains outside source control. */
import {Database} from 'bun:sqlite';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {WatchRssRepository} from '../../src/core/repository.ts';
const arg=(k:string,d='')=>process.argv.find(v=>v.startsWith(`--${k}=`))?.slice(k.length+3)??d;
const snapshot=arg('db');if(!snapshot)throw Error('--db=<readonly snapshot> required');
const framework=arg('framework',frameworkRoot),out=arg('out','/tmp/refresh-all.js');
const folder=mkdtempSync(resolve(tmpdir(),'refresh-replay-')),path=resolve(folder,'db.sqlite');
copyFileSync(snapshot,path);const raw=new Database(path),fixed=1750000000000,clock=Date.now;Date.now=()=>fixed;
try{
 const channels=raw.query("SELECT * FROM channels WHERE url LIKE 'http%' AND EXISTS(SELECT 1 FROM articles WHERE channel_id=channels.id AND content IS NOT NULL) ORDER BY id LIMIT 4").all() as any[];
 const esc=(v:any)=>String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 const cdata=(v:any)=>'<![CDATA['+String(v??'').replace(/\]\]>/g,']]]]><![CDATA[>')+']]>';
 const feeds:Record<string,string>={},sizes:any[]=[];
 for(let i=0;i<channels.length;i++){
  const c=channels[i],rows=raw.query('SELECT * FROM articles WHERE channel_id=? ORDER BY fetched_at DESC LIMIT 30').all(c.id) as any[];
  const atom=i%2===1;feeds[c.url]=atom?`<feed><title>${esc(c.title)}</title><subtitle>${esc(c.description)}</subtitle>${rows.map(a=>`<entry><id>${esc(a.guid)}</id><title>${esc(a.title)}</title><link href="${esc(a.link)}"/><summary>${cdata(a.description)}</summary><content>${cdata(a.content)}</content><updated>${esc(a.pub_date)}</updated></entry>`).join('')}</feed>`:`<rss><channel><title>${esc(c.title)}</title><description>${esc(c.description)}</description>${rows.map(a=>`<item><guid>${esc(a.guid)}</guid><title>${esc(a.title)}</title><link>${esc(a.link)}</link><description>${cdata(a.description)}</description><content:encoded>${cdata(a.content)}</content:encoded><pubDate>${esc(a.pub_date)}</pubDate></item>`).join('')}</channel></rss>`;
  sizes.push({id:c.id,format:atom?'Atom':'RSS',entries:rows.length,units:feeds[c.url].length,bytes:Buffer.byteLength(feeds[c.url])});
 }
 // Match production refresh-all's channel list while keeping the complete
 // snapshot article tables, unread aggregation and conflict state intact.
 raw.query('DELETE FROM channels WHERE id NOT IN ('+channels.map(()=>'?').join(',')+')').run(...channels.map(c=>c.id));
 const replies:any[]=[];
 const db={async query(sql:string,params:readonly any[]=[],label?:string){const value=raw.query(sql).all(...params) as any[];replies.push({method:'sql.query',sql,params,value});return value;},async execute(sql:string,params:readonly any[]=[]){raw.query(sql).run(...params);},async transaction(statements:any[]){raw.transaction(()=>{for(const s of statements)raw.query(s.sql).run(...s.params)})();replies.push({method:'sql.transaction',statements,value:null});}};
 const repo=new WatchRssRepository(db,async url=>{replies.push({method:'fixture.fetch',url,value:feeds[url]});return feeds[url];});
 const src=await Bun.file(resolve(import.meta.dir,'../../src/services.ts')).text();
 const refresh=src.slice(src.indexOf('  async refresh(channelId) {'),src.indexOf('  async markRead(id)')).trim().replace('async refresh(channelId)','async function refresh(channelId?:string)').replace(/},$/,'}');
 const list=src.slice(src.indexOf('  async listChannels() {'),src.indexOf('  async listArticles(')).trim();
 const listFunction=list.replace('async listChannels()','async function listChannels()').replace(/},$/,'}');
 const getList=new Function('db','init','return '+listFunction)(db,async()=>{});
 async function refreshChannel(id:string){await repo.refreshChannel(Number(id));await getList();}
 const runRefresh=new Function('repo','init','refreshChannel','return '+new Bun.Transpiler({loader:'ts'}).transformSync(refresh))(repo,async()=>{},refreshChannel);
 await runRefresh();const expected=await getList();
 await Bun.write(out+'.fixture.json',JSON.stringify({replies,expected,sizes,fixed}));
 const aliases:Record<string,string>={};for(const [key,file] of Object.entries((await Bun.file(resolve(framework,'packages/framework/package.json')).json()).exports) as [string,string][]){if(key.startsWith('./'))aliases['@podjs/framework/'+key.slice(2)]=resolve(framework,'packages/framework',file);}
 const result=await Bun.build({entrypoints:[resolve(import.meta.dir,'refresh-all-runner.ts')],target:'browser',format:'iife',alias:aliases,outdir:dirname(out),naming:out.split('/').at(-1),plugins:[{name:'real-refresh-functions',setup(b){b.onLoad({filter:/refresh-all-runner\.ts$/},async({path})=>({loader:'ts',contents:(await Bun.file(path).text()).replace('/* PRODUCTION_FUNCTIONS */',refresh+'\n'+listFunction)}));}}]});if(!result.success)throw Error(result.logs.join('\n'));
 await Bun.write(out,'globalThis.__refreshFixture='+await Bun.file(out+'.fixture.json').text()+';\n'+await Bun.file(out).text());
 console.log(JSON.stringify({out,channels:sizes,sqlCallbacks:replies.filter(r=>r.method==='sql.query').map(r=>({rows:r.value.length,bytes:Buffer.byteLength(JSON.stringify(r.value))})),transactions:replies.filter(r=>r.method==='sql.transaction').map(r=>({statements:r.statements.length,bytes:Buffer.byteLength(JSON.stringify(r.statements))}))}));
}finally{Date.now=clock;raw.close();rmSync(folder,{recursive:true,force:true});}
