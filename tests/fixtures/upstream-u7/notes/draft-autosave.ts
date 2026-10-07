import type { MemoNote } from "./types.ts";

export type NoteDraftSaveState = "empty" | "pending" | "saving" | "saved" | "error";
type NoteStore = Pick<{save(input:{noteId?:string;title?:string;markdown:string}):Promise<MemoNote>},"save">;

/** Serializes editor saves so a slower old write cannot overwrite a newer draft. */
export class NoteDraftAutosave {
  title:string;
  markdown:string;
  note:MemoNote|null;
  state:NoteDraftSaveState;
  private savedTitle:string;
  private savedMarkdown:string;
  private dueAt:number|undefined;
  private saving:Promise<MemoNote|null>|undefined;

  constructor(private readonly store:NoteStore,initial:MemoNote|null,private readonly onState?:(state:NoteDraftSaveState)=>void,private readonly onSaved?:(note:MemoNote)=>void,private readonly onError?:(error:unknown)=>void,private readonly delayMs=600,private readonly now=Date.now){
    this.note=initial;
    this.title=initial?.title??"";
    this.markdown=initial?.markdown??"";
    this.savedTitle=this.title;
    this.savedMarkdown=this.markdown;
    this.state=initial?"saved":"empty";
  }

  setTitle(value:string){if(value===this.title)return;this.title=value;this.changed();}
  setMarkdown(value:string){value=value.replace(/\r\n?/g,"\n");if(value===this.markdown)return;this.markdown=value;this.changed();}
  private setState(value:NoteDraftSaveState){if(this.state===value)return;this.state=value;this.onState?.(value);}
  private changed(){
    this.dueAt=undefined;
    if(!this.note&&!this.title.trim()&&!this.markdown.trim()){this.setState("empty");return;}
    this.setState(this.title===this.savedTitle&&this.markdown===this.savedMarkdown?"saved":"pending");
    if(this.state==="pending")this.dueAt=this.now()+this.delayMs;
  }
  tick(){if(this.dueAt===undefined||this.now()<this.dueAt)return;this.dueAt=undefined;void this.flush().catch(error=>this.onError?.(error));}
  private async saveOnce():Promise<MemoNote|null>{
    if(this.saving)return this.saving;
    if(this.title===this.savedTitle&&this.markdown===this.savedMarkdown)return this.note;
    if(!this.note&&!this.title.trim()&&!this.markdown.trim()){this.setState("empty");return null;}
    const title=this.title,markdown=this.markdown,noteId=this.note?.noteId;
    this.setState("saving");
    const work=this.store.save({noteId,title,markdown});
    this.saving=work.then(saved=>{
      this.note=saved;this.savedTitle=saved.title;this.savedMarkdown=saved.markdown;
      this.onSaved?.(saved);
      this.setState(this.title===saved.title&&this.markdown===saved.markdown?"saved":"pending");
      return saved;
    },error=>{this.setState("error");throw error;}).finally(()=>{this.saving=undefined;});
    return this.saving;
  }
  async flush():Promise<MemoNote|null>{
    this.dueAt=undefined;
    while(true){
      await this.saveOnce();
      if(this.title===this.savedTitle&&this.markdown===this.savedMarkdown)return this.note;
    }
  }
  dispose(){this.dueAt=undefined;}
}
