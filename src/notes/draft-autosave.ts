import {DraftAutosave,type AutosaveState} from '@podjs/framework/editing';
import type {MemoNote} from './types';
export type NoteDraftSaveState=AutosaveState;
type NoteStore=Pick<{save(input:{noteId?:string;title?:string;markdown:string}):Promise<MemoNote>},'save'>;
type Draft={title:string;markdown:string};
type SavedDraft={note:MemoNote;draft:Draft};
const draftOf=(note:MemoNote|null):Draft=>({title:note?.title??'',markdown:note?.markdown??''});
/** WatchRSS fields, newline normalization and note identity stay at this boundary. */
export class NoteDraftAutosave {
 private readonly autosave:DraftAutosave<Draft,SavedDraft>;
 constructor(store:NoteStore,initial:MemoNote|null,onState?:(state:NoteDraftSaveState)=>void,onSaved?:(note:MemoNote)=>void,onError?:(error:unknown)=>void,delayMs=600,now=Date.now){
  this.autosave=new DraftAutosave({initial:draftOf(initial),saved:initial&&{note:initial,draft:draftOf(initial)},
   // The repository derives a display title for a blank title field. Track
   // the submitted draft separately so that a derived title stays saved.
   save:async (draft,previous)=>({note:await store.save({noteId:previous?.note.noteId,...draft}),draft}),
   valueOf:saved=>saved.draft,
   equal:(a,b)=>a.title===b.title&&a.markdown===b.markdown,isEmpty:value=>!value.title.trim()&&!value.markdown.trim(),
   onState,onSaved:saved=>onSaved?.(saved.note),onError,delayMs,now});
 }
 get title(){return this.autosave.value.title;}
 set title(value:string){this.autosave.value={...this.autosave.value,title:value};}
 get markdown(){return this.autosave.value.markdown;}
 set markdown(value:string){this.autosave.value={...this.autosave.value,markdown:value};}
 get note(){return this.autosave.saved?.note??null;}
 set note(value:MemoNote|null){this.autosave.saved=value&&{note:value,draft:draftOf(value)};}
 get state(){return this.autosave.state;}
 set state(value:NoteDraftSaveState){this.autosave.state=value;}
 setTitle(value:string){this.autosave.setValue({...this.autosave.value,title:value});}
 setMarkdown(value:string){this.autosave.setValue({...this.autosave.value,markdown:value.replace(/\r\n?/g,'\n')});}
 tick(){this.autosave.tick();}
 async flush(){return (await this.autosave.flush())?.note??null;}
 dispose(){this.autosave.dispose();}
}
