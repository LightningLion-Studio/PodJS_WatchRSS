import {fail,hex,type Envelope,type ObjectDescriptor,type Selection} from './wire';

export const MAX_REQUEST_BINDINGS=8192;
export function bindingCapacity(selection:Selection):number{
 return selection.kinds.some(k=>k.kind==='bookPackageSegment')?12288:MAX_REQUEST_BINDINGS;
}
type RequestBinding=Pick<Envelope,'requestId'|'requestDigest'>;

/** Validated manifest rows are fixed for a connection grant. The caller loads
 * them before enabling DATA, within the watch manifest and object limits. */
export class ReceiveIndex {
 private readonly descriptors:readonly ObjectDescriptor[];
 private readonly applied:Set<string>;
 constructor(descriptors:readonly ObjectDescriptor[],applied:readonly string[]){
  this.descriptors=Object.freeze([...descriptors]);
  this.applied=new Set(applied);
 }
 at(slot:number):ObjectDescriptor|null{return this.descriptors[slot]??null;}
 slot(id:string):number{return this.descriptors.findIndex(object=>object.objectId===id);}
 isApplied(id:string):boolean{return this.applied.has(id);}
 didApply(id:string):void{this.applied.add(id);}
}

/** Request bindings shared by the DATA and CONTROL lanes for one grant. */
export class ReceiveBindings {
 private readonly requests=new Map<string,string>();
 constructor(private readonly capacity=MAX_REQUEST_BINDINGS){}
 hasBinding(r:RequestBinding):boolean{
  const prior=this.requests.get(r.requestId);
  if(prior!==undefined&&prior!==r.requestDigest)fail('REQUEST_CONFLICT');
  return prior!==undefined;
 }
 *pages():Generator<RequestBinding[]>{
  let page:RequestBinding[]=[];
  for(const [requestId,requestDigest] of this.requests){
   page.push({requestId,requestDigest});
   if(page.length===128){yield page;page=[];}
  }
  if(page.length)yield page;
 }
 remember(r:RequestBinding):void{
  if(this.hasBinding(r))return;
  if(this.requests.size>=this.capacity)fail('STORAGE_PRESSURE');
  this.requests.set(hex(r.requestId,32),hex(r.requestDigest));
 }
}
