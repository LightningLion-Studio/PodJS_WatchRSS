import { afterEach, expect, test } from 'bun:test'

let statusCapability = false
const events: unknown[] = []
const emitted: Record<string, unknown>[] = []

;
(globalThis as { pod?: unknown }).pod = {
  takeEvents: () => events.length ? JSON.stringify(events.splice(0)) : undefined,
  emit: (line: string) => emitted.push(JSON.parse(line) as Record<string, unknown>),
  capabilities: () => JSON.stringify(['system.browser.auth', 'data.secure', ...(statusCapability ? ['system.browser.auth.status'] : [])]),
}

const runtime = await import('@podjs/framework/watch')
const { authorizeInBrowser } = await import('../src/media/browser-auth')

afterEach(() => { events.length = 0; emitted.length = 0; statusCapability = false })

test('sends only explicit browser authorization inputs', async () => {
  const operation = authorizeInBrowser({
    url: 'https://www.douyin.com/chat?isPopup=1',
    cookieOrigin: 'https://www.douyin.com',
    requiredCookieNames: ['sessionid'],
    userAgent: 'desktop-test-agent',
  })
  expect(emitted[0]).toMatchObject({
    method: 'browser.authorize',
    args: {
      url: 'https://www.douyin.com/chat?isPopup=1',
      cookieOrigin: 'https://www.douyin.com',
      requiredCookieNames: ['sessionid'],
      userAgent: 'desktop-test-agent',
    },
  })
  operation.cancel()
  await expect(operation.result).rejects.toMatchObject({ code: 'cancelled' })
})


test('status wrapper uses SDK event transport and waits for explicit cookie result', async () => {
  statusCapability = true;
  const statuses: unknown[] = [];
  const operation = authorizeInBrowser({url:'https://www.douyin.com/chat?isPopup=1',cookieOrigin:'https://www.douyin.com',requiredCookieNames:['sessionid'],qrExtractionScript:'status-script',onStatus: value => statuses.push(value)});
  const command = emitted[0]!;
  expect(command.method).toBe('browser.authorizeWithStatus');
  expect(command.args).not.toHaveProperty('onStatus');
  let settled=false; void operation.result.then(()=>settled=true);
  const qr={type:'qr',kind:'secondVerify',mime:'image/jpeg',imageBase64:'cXI='};
  events.push({t:'browser.auth.status',id:command.id,value:qr}); runtime.__pumpPodEvents();
  await Promise.resolve(); expect(statuses).toEqual([qr]); expect(settled).toBe(false);
  const value={cookie:'sessionid=test',origin:'https://www.douyin.com'};
  events.push({t:'service.result',id:command.id,ok:true,value}); runtime.__pumpPodEvents();
  expect(await operation.result).toEqual(value);
});

test('QR waiting-only wrapper forwards generic config and local state hook without exposing callback on wire',async()=>{
 statusCapability=true;const waits:unknown[]=[];
 const operation=authorizeInBrowser({url:'https://example.com',cookieOrigin:'https://example.com',requiredCookieNames:['sid'],qrWait:{message:'Wait'},onQrWait:state=>waits.push(state)});
 const command=emitted[0]!;expect(command.method).toBe('browser.authorizeWithStatus');expect(command.args).toMatchObject({qrWait:{message:'Wait'}});expect(command.args).not.toHaveProperty('onQrWait');
 events.push({t:'browser.auth.status',id:command.id,value:{type:'pageState',loading:false}});runtime.__pumpPodEvents();expect(waits.at(-1)).toEqual({visible:true,message:'Wait'});
 operation.cancel();await expect(operation.result).rejects.toMatchObject({code:'cancelled'});expect(waits.at(-1)).toEqual({visible:false,message:'Wait'});
});
