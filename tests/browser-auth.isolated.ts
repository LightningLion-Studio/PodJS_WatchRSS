import { afterEach, expect, test } from 'bun:test'

const events: unknown[] = []
const emitted: Record<string, unknown>[] = []

;
(globalThis as { pod?: unknown }).pod = {
  takeEvents: () => events.length ? JSON.stringify(events.splice(0)) : undefined,
  emit: (line: string) => emitted.push(JSON.parse(line) as Record<string, unknown>),
  capabilities: () => JSON.stringify(['system.browser.auth', 'data.secure']),
}

const runtime = await import('@podjs/framework/watch')
const { authorizeInBrowser } = await import('../src/media/browser-auth')

afterEach(() => { events.length = 0; emitted.length = 0 })

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
