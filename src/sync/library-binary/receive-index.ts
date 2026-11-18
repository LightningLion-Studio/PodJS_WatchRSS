import {fail,hex,type Envelope,type ObjectDescriptor} from './wire';

export const MAX_REQUEST_BINDINGS=8192;
type RequestBinding=Pick<Envelope,'requestId'|'requestDigest'>;

/** Validated manifest rows are fixed for a connection grant. The caller loads
 * them before enabling DATA, within the watch manifest and object limits. */
export class ReceiveIndex {
 private readonly descriptors:readonly ObjectDescriptor[];
 private readonly applied:Set<string>;
 private readonly requests=new Map<string,string>();
 constructor(descriptors:readonly ObjectDescriptor[],applied:readonly string[],requests:readonly RequestBinding[]){
  this.descriptors=Object.freeze([...descriptors]);
  this.applied=new Set(applied);
  for(const request of requests)this.remember(request);
 }
 at(slot:number):ObjectDescriptor|null{return this.descriptors[slot]??null;}
 slot(id:string):number{return this.descriptors.findIndex(object=>object.objectId===id);}
 isApplied(id:string):boolean{return this.applied.has(id);}
 didApply(id:string):void{this.applied.add(id);}
 hasBinding(r:RequestBinding):boolean{
  const prior=this.requests.get(r.requestId);
  if(prior!==undefined&&prior!==r.requestDigest)fail('REQUEST_CONFLICT');
  return prior!==undefined;
 }
 remember(r:RequestBinding):void{
  if(this.hasBinding(r))return;
  if(this.requests.size>=MAX_REQUEST_BINDINGS)fail('STORAGE_PRESSURE');
  this.requests.set(hex(r.requestId,32),hex(r.requestDigest));
 }
}
