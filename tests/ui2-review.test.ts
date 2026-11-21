import {expect,test} from 'bun:test';
import {logReceiptTime} from '../src/ui/log-receipt-time.ts';
import {browserOpenFailureMessage} from '../src/browser/open-failure.ts';
import {AppLogger,installAppLogger} from '../src/logs/app-logger.ts';

test('log receipts use one short timestamp in the local timezone',()=>{
  expect(logReceiptTime(new Date(2026,10,20,10,27).toISOString())).toBe('11-20 10:27');
  expect(logReceiptTime('bad timestamp')).toBe('时间未知');
});

test('browser failure presents Chinese guidance and logs its diagnostic code',()=>{
  const messages:string[]=[];
  installAppLogger(new AppLogger({read:async()=>null,size:async()=>0,replace:async()=>{},append:async()=>{}},()=>new Date(),(_,line)=>messages.push(line)));
  try {
    const message=browserOpenFailureMessage(new Error('no_browser_handler'),'scan-qr');
    expect(message).toBe('无法打开浏览器，\n请用手机扫码');
    expect(messages[0]).toContain('no_browser_handler');
  } finally {
    installAppLogger(undefined);
  }
});
