import {DraftAutosave,type AutosaveState} from '@podjs/framework/editing';
import type {MemoNote} from './types';
export type NoteDraftSaveState=AutosaveState;
type NoteStore=Pick<{save(input:{noteId?:string;title?:string;markdown:string}):Promise<MemoNote>},'save'>;
type Draft={title:string;markdown:string};
/** WatchRSS fields, newline normalization and note identity stay at this boundary. */
export class NoteDraftAutosave {
 private readonly autosave:DraftAutosave<Draft,MemoNote>;
 constructor(store:NoteStore,initial:MemoNote|null,onState?:(state:NoteDraftSaveState)=>void,onSaved?:(note:MemoNote)=>void,onError?:(error:unknown)=>void,delayMs=600,now=Date.now){
  this.autosave=new DraftAutosave({initial:{title:initial?.title??'',markdown:initial?.markdown??''},saved:initial,
   save:(value,previous)=>store.save({noteId:previous?.noteId,...value}),valueOf:note=>({title:note.title,markdown:note.markdown}),
   equal:(a,b)=>a.title===b.title&&a.markdown===b.markdown,isEmpty:value=>!value.title.trim()&&!value.markdown.trim(),
   onState,onSaved,onError,delayMs,now});
 }
 get title(){return this.autosave.value.title;}
 set title(value:string){this.autosave.value={...this.autosave.value,title:value};}
 get markdown(){return this.autosave.value.markdown;}
 set markdown(value:string){this.autosave.value={...this.autosave.value,markdown:value};}
 get note(){return this.autosave.saved;}
 set note(value:MemoNote|null){this.autosave.saved=value;}
 get state(){return this.autosave.state;}
 set state(value:NoteDraftSaveState){this.autosave.state=value;}
 setTitle(value:string){this.autosave.setValue({...this.autosave.value,title:value});}
 setMarkdown(value:string){this.autosave.setValue({...this.autosave.value,markdown:value.replace(/\r\n?/g,'\n')});}
 tick(){this.autosave.tick();}
 flush(){return this.autosave.flush();}
 dispose(){this.autosave.dispose();}
}
