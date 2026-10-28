export interface PendingPhoneChange {appealId:string;status:'cooling'|'ready';effectiveAt:number;phoneMasked:string;cancellable:boolean;message:string;}
export function phoneNotice(value:unknown):PendingPhoneChange|null {
 if(value==null)return null;const p=value as Record<string,unknown>;
 if(typeof p.appealId!=='string'||!['cooling','ready'].includes(String(p.status))||typeof p.effectiveAt!=='number'||!Number.isFinite(p.effectiveAt)||typeof p.phoneMasked!=='string'||!p.phoneMasked.includes('*'))throw Error('账号安全提示响应无效');
 const d=new Date(p.effectiveAt),date=`${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日`;
 return {appealId:p.appealId,status:p.status as 'cooling'|'ready',effectiveAt:p.effectiveAt,phoneMasked:p.phoneMasked,cancellable:p.cancellable===true,message:`手机号将于${date}变更，如非本人操作请联系支持`};
}
