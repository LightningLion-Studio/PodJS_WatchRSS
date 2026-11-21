export function logReceiptTime(value:string):string {
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return '时间未知';
  const pad=(n:number)=>String(n).padStart(2,'0');
  return `${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
