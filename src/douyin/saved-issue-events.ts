export interface SavedIssueContext{itemId:string;savedAtMillis?:number}
export interface SavedIssueOccurrence{atMillis:number;stage:'resolve'|'player';code:string}
let sink:((context:SavedIssueContext,event:SavedIssueOccurrence)=>void)|undefined;
export function installSavedIssueSink(value:typeof sink){sink=value;}
export function emitSavedIssue(context:SavedIssueContext,event:SavedIssueOccurrence){try{sink?.(context,event);}catch{}}
