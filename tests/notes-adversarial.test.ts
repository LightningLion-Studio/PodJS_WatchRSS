import {deriveNoteTitle} from '../src/notes/title';
const productRoot=process.env.NOTES_SOURCE_ROOT??new URL('../',import.meta.url).pathname;
import {test,expect} from 'bun:test';
import {Database} from 'bun:sqlite';
const {MemoRepository}=await import(productRoot+'/src/notes/repository');
const {mergeNoteMarkdown}=await import(productRoot+'/src/notes/merge');
const {decodeNoteCloudState,encodeNoteCloudState,exportNoteMarkdown}=await import(productRoot+'/src/notes/cloud-state');
const {syncNotes}=await import(productRoot+'/src/sync/note-actions');
const {prepareNotePreview}=await import(productRoot+'/src/notes/preview');
const {noteTextRows}=await import(productRoot+'/src/notes/presentation');
const {noteUpsert}=await import(productRoot+'/src/sync-v2/note-rows');
import {sha256Hex} from '@podjs/framework/crypto';
const {utf8Encode}=await import(productRoot+'/src/cloud/types');
import type {SqlDatabase} from '../src/core/types';
const hash=(s:string)=>sha256Hex(utf8Encode(s));
function store(){const sql=new Database(':memory:');const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{sql.query(q).run(...p as any[])},transaction:async ss=>sql.transaction(()=>ss.forEach(s=>sql.query(s.sql).run(...(s.params??[]) as any[])))()};let now=100;const repo=new MemoRepository(db,'watch',()=> 'n',()=>now++);return {sql,db,repo,setClock:(v:number)=>{now=v}};}
const changed=(n:any,body:string,time:number)=>({...n,markdown:body,plainText:body,contentHash:hash(body),updatedAt:time,modifiedBy:'peer'});
test('NA-01 insertion beside replacement retains inserted text or conflicts',()=>{expect([null,'x\nb']).toContain(mergeNoteMarkdown('a','x\na','b'))});
test('NA-02 same-position inserts converge or conflict',()=>{expect(mergeNoteMarkdown('a','x\na','y\na')).toBe(mergeNoteMarkdown('a','y\na','x\na'))});
test('NA-04 real Bluetooth action does not discard a divergent local edit',async()=>{const f=store();try{await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});await f.repo.save({noteId:a.noteId,title:'T',markdown:'local'});const remote=changed(a,'remote',300);await syncNotes({action:'syncNotes',notes:[remote]},f.repo,async()=> 'watch');const saved=await f.repo.get('n');expect(saved?.markdown).toBe('local');}finally{f.sql.close()}});
test('NA-06 newer delete of ancestor must delete or record conflict',async()=>{const f=store();try{await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});await f.repo.save({noteId:'n',title:'T',markdown:'local'});await f.repo.applyRemote({...a,deleted:true,deletedAt:300,updatedAt:300});const rows=await f.db.query('SELECT * FROM note_merge_conflicts');expect((await f.repo.allIncludingDeleted())[0].deleted||rows.length>0).toBe(true);}finally{f.sql.close()}});
test('NA-07 sequential peer edit based on last local version is not a conflict',async()=>{const f=store();try{await f.repo.initialize();await f.repo.save({title:'T',markdown:'a'});const b=await f.repo.save({noteId:'n',title:'T',markdown:'b'});await f.repo.applyRemote({...changed(b,'c',300),baseMarkdown:'b',baseContentHash:hash('b')});expect((await f.repo.get('n'))?.markdown).toBe('c');}finally{f.sql.close()}});
test('NA-09 clock rollback does not erase pin',async()=>{const f=store();try{await f.repo.initialize();f.setClock(1000);const a=await f.repo.save({title:'T',markdown:'a'});f.setClock(100);await f.repo.setPinned('n',true);await f.repo.applyRemote(a);expect((await f.repo.get('n'))?.pinned).toBe(true);}finally{f.sql.close()}});
test('NA-10 independent body merge preserves uncontested peer folder',async()=>{const f=store();try{await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a\nb'});await f.repo.save({noteId:'n',title:'T',markdown:'A\nb'});await f.repo.applyRemote({...changed(a,'a\nB',300),title:'Peer',folderId:'peer-folder'});expect((await f.repo.get('n'))?.folderId).toBe('peer-folder');}finally{f.sql.close()}});
test('NA-12 fenced HTML literal stays in code preview',()=>{const blocks=prepareNotePreview('```html\n<img src="x">\n```');expect(blocks.some(b=>b.kind==='image')).toBe(false);expect(blocks.filter(b=>b.kind==='rich').flatMap(b=>noteTextRows(b.markup,b.html)).some(r=>r.role==='code'&&r.text.includes('<img'))).toBe(true)});
test('NA-CONTROL unicode across SQLite 64K pieces and six cloud codec passes',async()=>{const f=store();try{await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});const body='a'.repeat(65535)+'👨‍👩‍👧‍👦\r\n\u0000\u2028\u2029ééאבג\\"';const n={...a,markdown:body,plainText:body,baseMarkdown:body,contentHash:hash(body),baseContentHash:hash(body)};await f.db.transaction(noteUpsert(n));expect((await f.repo.get('n'))?.markdown).toBe(body);let x=n;for(let i=0;i<6;i++)x=decodeNoteCloudState(encodeNoteCloudState([x]))[0];expect(x.markdown).toBe(body)}finally{f.sql.close()}});

test('NA-16 conflict ID separates arbitrary NUL-bearing strings',async()=>{const f=store();try{await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});await f.repo.save({noteId:'n',title:'T',markdown:'x\u0000y'});await f.repo.applyRemote(changed(a,'z',300));await f.repo.save({noteId:'n',title:'T',markdown:'x'});await f.repo.applyRemote(changed(a,'y\u0000z',400));expect(await f.db.query('SELECT * FROM note_merge_conflicts')).toHaveLength(2)}finally{f.sql.close()}});

test.skipIf(!process.env.NOTES_TITLE_MODULE)('NA-15 pC3 derived title retains Unicode scalars at the 80-unit cap',async()=>{const file=process.env.NOTES_TITLE_MODULE;if(!file){console.log('NA-15 SKIP: pass NOTES_TITLE_MODULE for pC3');return;}const {deriveNoteTitle}=await import(file);const title=deriveNoteTitle('.'.repeat(79)+'😀');expect(title.isWellFormed()).toBe(true)});

test('NA-16 legacy repository ID suppresses new duplicate incident',async()=>{const f=store();try{
 await f.repo.initialize();const a=await f.repo.save({title:'T',markdown:'a'});await f.repo.save({noteId:'n',title:'T',markdown:'b'});
 const remote=changed(a,'c',300);await f.repo.applyRemote(remote);
 const legacy=hash(['n','a','b','c','peer'].join('\0'));await f.db.execute('UPDATE note_merge_conflicts SET conflict_id=?',[legacy]);
 await f.db.execute('DELETE FROM note_cloud_receipts');await f.repo.applyRemote(remote);
 const rows=await f.db.query('SELECT * FROM note_merge_conflicts');expect(rows).toHaveLength(1);expect(rows[0].conflict_id).toBe(legacy);
}finally{f.sql.close()}});

test('NA-15 derived title retains Unicode scalars',()=>{expect(deriveNoteTitle('.'.repeat(79)+'😀')).toBe('.'.repeat(79)+'😀')});

for(const fence of ['```','~~~~','   ```']){
 test('NA-12 mixed rich HTML protects '+JSON.stringify(fence),()=>{
  const blocks=prepareNotePreview('<img src="real">\n'+fence+'html\n<img src="literal">\n'+fence.trim());
  expect(blocks.filter(b=>b.kind==='image').map(b=>b.path)).toEqual(['real']);
  expect(blocks.filter(b=>b.kind==='rich').flatMap(b=>noteTextRows(b.markup,b.html)).filter(r=>r.role==='code').map(r=>r.text)).toEqual(['<img src="literal">']);
 });
}
test('NA-12 unclosed fence and mismatched delimiters remain code',()=>{
 const source='```html\n<img src="literal">\n~~~\n<img src="still-literal">';
 const blocks=prepareNotePreview(source);
 expect(blocks.some(b=>b.kind==='image')).toBe(false);
 expect(blocks.filter(b=>b.kind==='rich').flatMap(b=>noteTextRows(b.markup,b.html)).map(r=>r.text)).toEqual(['<img src="literal">','~~~','<img src="still-literal">']);
});
