import {expect,test} from 'bun:test';
import {decodeMediaText,type MediaDecodeProgress} from '../../src/media/text.ts';
import {decodeDiagnostic} from '../../src/douyin/request-diagnostics.ts';

test('a join allocation denial uses the existing bytes and waits for one budget sample if needed',async()=>{
  const body=JSON.stringify({value:'中🙂'.repeat(20_000)});
  const bytes=new TextEncoder().encode(body);
  const original=Array.prototype.join;
  const old=(globalThis as {pod?:unknown}).pod;
  const waits:number[]=[];
  let fullDecodes=0;
  (globalThis as {pod?:unknown}).pod={decodeUtf8:(value:Uint8Array)=>{
    if(value===bytes&&++fullDecodes===1)throw Error('out of memory');
    return new TextDecoder('utf-8',{fatal:true}).decode(value);
  }};
  Array.prototype.join=function(this:unknown[],separator?:string){
    if(separator===''&&typeof this[0]==='string'&&this[0].startsWith('{"value":"中'))throw Error('out of memory');
    return original.call(this,separator);
  };
  try {
    const progress:MediaDecodeProgress={step:'piece',offset:0,portable:false};
    expect(await decodeMediaText(bytes,'douyin',async ms=>{waits.push(ms??1);},progress)).toBe(body);
    expect(fullDecodes).toBe(2);
    expect(waits.filter(ms=>ms>1)).toEqual([850]);
    expect(progress).toMatchObject({offset:bytes.length,portable:false,recovered:true});
  }finally{
    Array.prototype.join=original;
    (globalThis as {pod?:unknown}).pod=old;
  }
});

test('response decode diagnostics emit framing and a closed reason only',()=>{
  const bytes=new TextEncoder().encode('{"aweme_list":["PRIVATE"]}');
  const probe=decodeDiagnostic(bytes,{step:'join',offset:bytes.length,portable:false},'join',Error('out of memory'));
  expect(probe).toEqual({decode_step:'join',decode_reason:'memory',body_shape:'json_object',decode_offset:bytes.length,decode_portable:false});
  expect(JSON.stringify(probe)).not.toContain('PRIVATE');
});

test('a budgeted response uses one bounded native string allocation before staging pieces',async()=>{
  const body=JSON.stringify({value:'中🙂'.repeat(20_000)});
  const bytes=new TextEncoder().encode(body);
  const old=(globalThis as {pod?:unknown}).pod;
  const lengths:number[]=[];
  (globalThis as {pod?:unknown}).pod={
    memoryBudgetBytes:()=>128_000_000,
    decodeUtf8:(value:Uint8Array)=>{
      lengths.push(value.length);
      return new TextDecoder('utf-8',{fatal:true}).decode(value);
    },
  };
  try {
    expect(await decodeMediaText(bytes,'douyin',async()=>{})).toBe(body);
    expect(lengths).toEqual([bytes.length]);
  }finally{
    (globalThis as {pod?:unknown}).pod=old;
  }
});
