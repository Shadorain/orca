import { spawnProcess } from '@orca/process-host'
import { createServer } from 'node:http'
import { createServer as createPortServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build as buildVite } from 'vite'
import { waitForBrowserCdpEndpoint } from './browser-session-ua-cdp-collector'

type Receipt = {
  path: string
  method: string
  body: string
  cookie: string
  referrer: string
  contentType: string
  proxied: boolean
}
const receipts: Receipt[] = []
const root = mkdtempSync(join(tmpdir(), 'orca-popup-compatibility-'))
let fixture: ReturnType<typeof spawnProcess> | null = null
let browser: Browser | null = null
let origin = ''
let stderr = ''
const pages = new Map<string, Page>()
const statusPath = join(root, 'status.json')
const artifactDir = process.env.ORCA_POPUP_FIXTURE_ARTIFACT_DIR
const snapshots: ReturnType<typeof status>[] = []
const expectedSecurity = { sandbox: true, contextIsolation: true, nodeIntegration: false }

function status(): {
  ready?: boolean
  error?: string
  windowsHidden: boolean
  tabOpens: { url: string; activate: boolean }[]
  blocked: number[]
  inputs: string[]
  childRequests: {
    adopted: boolean
    hasPostBody: boolean
    hasReferrer: boolean
    sessionMatches: boolean
    security: typeof expectedSecurity
    permission?: string
  }[]
  routeGranted: boolean
  routeContents: { security: typeof expectedSecurity; webRtcPolicy: string }[]
} {
  return JSON.parse(readFileSync(statusPath, 'utf8'))
}

function fixtureHtml(): string {
  return `<!doctype html><meta name="referrer" content="same-origin"><body>
    <button id="oauth" onclick="window.popup=window.open('/authorize?client_id=synthetic&amp;redirect_uri=${origin}/callback&amp;response_type=code');document.body.dataset.handle=String(!!window.popup)">OAuth</button>
    <button id="blank" onclick="window.popup=window.open('about:blank#state');document.body.dataset.handle=String(!!window.popup);if(window.popup)window.popup.eval(&quot;window.opener.postMessage('blank:'+document.cookie,'*')&quot;)">Blank</button>
    <button id="invalid" onclick="window.popup=window.open('about:blank?state=synthetic');document.body.dataset.handle=String(!!window.popup)">Invalid</button>
    <button id="burst" onclick="window.handles=Array.from({length:5},()=>window.open('about:blank'));document.body.dataset.handles=JSON.stringify(window.handles.map(Boolean))">Burst</button>
    <button id="stale" onclick="document.body.dataset.handle='waiting';setTimeout(()=>{window.popup=window.open('about:blank');document.body.dataset.handle=String(!!window.popup)},1100)">Stale</button>
    <form method="post" target="_blank" action="/post"><input name="code" value="synthetic+value"><button id="post">POST</button></form>
    <form method="post" target="_blank" action="/multipart" enctype="multipart/form-data"><input name="code" value="synthetic-multipart"><button id="multipart">Multipart</button></form>
    <form method="post" target="_blank" action="/empty"><button id="empty">Empty POST</button></form>
    <a id="link" href="/docs" target="_blank">Docs</a>
    <a id="background" href="/background">Background</a>
    <a id="shift" href="/shift">Popup link</a>
    <script>window.addEventListener('message',event=>document.body.dataset.message=event.data)</script>
  </body>`
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    const path = new URL(request.url ?? '/', origin).pathname
    receipts.push({
      path,
      method: request.method ?? '',
      body: Buffer.concat(chunks).toString(),
      cookie: request.headers.cookie ?? '',
      referrer: request.headers.referer ?? '',
      contentType: request.headers['content-type'] ?? '',
      proxied: request.url?.startsWith('http:') ?? false
    })
    response.setHeader('Content-Type', 'text/html')
    response.end(
      path === '/local' || path === '/route'
        ? fixtureHtml()
        : `<body>${path}<script>if(window.opener)window.opener.postMessage('callback:'+document.cookie,'*')</script></body>`
    )
  })
})

async function reservePort(): Promise<number> {
  const portServer = createPortServer()
  await new Promise<void>((resolve) => portServer.listen(0, '127.0.0.1', resolve))
  const address = portServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing CDP port')
  }
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  return address.port
}

async function waitForFixture(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 20_000
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Popup fixture did not become ready: ${stderr}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing mock origin')
  }
  origin = `http://127.0.0.1:${address.port}`
  // Build current source, including the hidden BaseWindow policy, before any Electron launch.
  await buildVite({
    configFile: false,
    logLevel: 'silent',
    build: {
      lib: {
        entry: join(
          process.cwd(),
          'src/main/browser/browser-popup-compatibility-electron-fixture.ts'
        ),
        formats: ['cjs'],
        fileName: () => 'main.cjs'
      },
      outDir: root,
      emptyOutDir: false,
      target: 'node22',
      rollupOptions: { external: ['electron', /^node:/] }
    }
  })
  const electronBinary: unknown = createRequire(import.meta.url)('electron')
  if (typeof electronBinary !== 'string') {
    throw new Error('Missing Electron executable')
  }
  const cdpPort = await reservePort()
  const args = [
    join(root, 'main.cjs'),
    `--user-data-dir=${join(root, 'profile')}`,
    `--remote-debugging-port=${cdpPort}`
  ]
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
  fixture = spawnProcess({
    program: process.platform === 'linux' ? 'xvfb-run' : electronBinary,
    args:
      process.platform === 'linux'
        ? ['--auto-servernum', electronBinary, ...args, '--no-sandbox']
        : args,
    env: {
      ...env,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_POPUP_FIXTURE_ORIGIN: origin,
      ORCA_POPUP_FIXTURE_STATUS: statusPath
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  fixture.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  await waitForBrowserCdpEndpoint(cdpPort)
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`)
  await waitForFixture(() => {
    if (!existsSync(statusPath)) {
      return false
    }
    const current = status()
    if (current.error) {
      throw new Error(current.error)
    }
    return current.ready === true
  })
  expect(status()).toMatchObject({ ready: true, windowsHidden: true })
  for (const name of ['local', 'route']) {
    await waitForFixture(() =>
      Boolean(
        browser
          ?.contexts()
          .flatMap((context) => context.pages())
          .some((page) => page.url() === `${origin}/${name}`)
      )
    )
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() === `${origin}/${name}`)
    if (!page) {
      throw new Error('Missing guest page')
    }
    pages.set(name, page)
  }
}, 60_000)

afterAll(async () => {
  if (artifactDir && existsSync(statusPath)) {
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(
      join(artifactDir, 'electron-evidence.json'),
      JSON.stringify({ status: status(), receipts, snapshots }, null, 2)
    )
  }
  if (fixture?.exitCode === null) {
    const exited = new Promise<void>((resolve) => fixture?.once('exit', () => resolve()))
    fixture.kill('SIGTERM')
    await exited
  }
  await browser?.close().catch(() => {})
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function guest(name: string): Page {
  const page = pages.get(name)
  if (!page) {
    throw new Error('Missing fixture guest')
  }
  return page
}

async function closeChildren(page: Page): Promise<void> {
  await page.evaluate('window.popup?.close();window.handles?.forEach(handle=>handle?.close())')
  if (!browser) {
    throw new Error('Missing fixture browser')
  }
  for (const child of browser.contexts().flatMap((context) => context.pages())) {
    if (
      !pages.has(new URL(child.url(), origin).pathname.slice(1)) &&
      child.url().startsWith(origin)
    ) {
      await child.evaluate('window.close()').catch(() => {})
    }
  }
}

describe('hidden Chromium popup compatibility', () => {
  it.each(['local', 'route'])(
    'preserves bare OAuth and blank handles, messages, sessions and close: %s',
    async (name) => {
      const page = guest(name)
      await page.locator('#oauth').click()
      await expect.poll(() => page.locator('body').getAttribute('data-handle')).toBe('true')
      await expect
        .poll(() => page.locator('body').getAttribute('data-message'))
        .toBe(`callback:synthetic_session=${name}`)
      expect(await page.evaluate('!!window.popup.opener')).toBe(true)
      await closeChildren(page)
      await expect.poll(() => page.evaluate('window.popup.closed')).toBe(true)
      await page.locator('#blank').click()
      await expect
        .poll(() => page.locator('body').getAttribute('data-message'))
        .toBe(`blank:synthetic_session=${name}`)
      expect(await page.evaluate('window.popup.location.href')).toBe('about:blank#state')
      expect(await page.evaluate('window.popup.eval("Notification.requestPermission()")')).toBe(
        'denied'
      )
      if (name === 'route') {
        expect(
          await page.evaluate('window.popup.eval(\'window.open("about:blank")===null\')')
        ).toBe(true)
        await page.evaluate('console.log("orca-popup-fixture:snapshot")')
        await expect.poll(() => status().routeContents.length).toBe(2)
        expect(status().routeContents).toEqual([
          { security: expectedSecurity, webRtcPolicy: 'disable_non_proxied_udp' },
          { security: expectedSecurity, webRtcPolicy: 'disable_non_proxied_udp' }
        ])
      }
      snapshots.push(status())
      if (artifactDir) {
        mkdirSync(artifactDir, { recursive: true })
        await page.screenshot({ path: join(artifactDir, `${name}-hidden-guest.png`) })
        const child = browser
          ?.contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => candidate.url() === 'about:blank#state')
        await child?.screenshot({ path: join(artifactDir, `${name}-hidden-blank.png`) })
      }
      await page.evaluate(`window.popup.location.href=${JSON.stringify(`${origin}/callback`)}`)
      await expect
        .poll(() => page.locator('body').getAttribute('data-message'))
        .toBe(`callback:synthetic_session=${name}`)
      await closeChildren(page)
      expect(status().windowsHidden).toBe(true)
      if (name === 'local') {
        expect(status().childRequests.every((request) => request.adopted)).toBe(true)
      }
    }
  )

  it.each(['local', 'route'])(
    'keeps POST bodies, headers, referrers and cookie jars: %s',
    async (name) => {
      for (const id of ['post', 'multipart', 'empty']) {
        const before = receipts.length
        await guest(name).locator(`#${id}`).click()
        await expect
          .poll(() => receipts.slice(before).find((receipt) => receipt.path === `/${id}`))
          .toMatchObject({
            method: 'POST',
            referrer: `${origin}/${name}`,
            cookie: `synthetic_session=${name}`,
            proxied: name === 'route'
          })
        const receipt = receipts.slice(before).find((receipt) => receipt.path === `/${id}`)
        expect(receipt?.body).toEqual(
          id === 'post'
            ? 'code=synthetic%2Bvalue'
            : id === 'empty'
              ? ''
              : expect.stringContaining('synthetic-multipart')
        )
        expect(receipt?.contentType).toMatch(
          id === 'multipart'
            ? /^multipart\/form-data; boundary=/
            : /^application\/x-www-form-urlencoded/
        )
        await closeChildren(guest(name))
      }
    }
  )

  it('keeps ordinary local link activation and modifier-click tab UX', async () => {
    const page = guest('local')
    await page.locator('#link').click()
    await expect
      .poll(() => status().tabOpens.at(-1))
      .toEqual({ url: `${origin}/docs`, activate: true })
    await page.locator('#background').click({ button: 'middle' })
    await expect
      .poll(() => status().tabOpens.at(-1))
      .toEqual({ url: `${origin}/background`, activate: false })
    const before = receipts.length
    await page.locator('#shift').click({ modifiers: ['Shift'] })
    await expect
      .poll(() => receipts.slice(before).find((receipt) => receipt.path === '/shift'))
      .toMatchObject({
        method: 'GET',
        referrer: `${origin}/local`,
        cookie: 'synthetic_session=local'
      })
    expect(status().childRequests.at(-1)).toMatchObject({
      adopted: false,
      hasReferrer: true,
      sessionMatches: true,
      security: expectedSecurity
    })
    await expect.poll(() => status().childRequests.at(-1)?.permission).toBe('denied')
    expect(status().childRequests.every((request) => request.sessionMatches)).toBe(true)
    snapshots.push(status())
    await closeChildren(page)
  })

  it('retains remote no-gesture, stale-gesture, scheme and four-window guards', async () => {
    const page = guest('route')
    expect(await page.evaluate('window.open("about:blank")===null')).toBe(true)
    await page.locator('#invalid').click()
    expect(await page.locator('body').getAttribute('data-handle')).toBe('false')
    await page.locator('#stale').click()
    await expect
      .poll(() => page.locator('body').getAttribute('data-handle'), { timeout: 4_000 })
      .toBe('false')
    await page.locator('#burst').click()
    expect(await page.locator('body').getAttribute('data-handles')).toBe(
      '[true,false,false,false,false]'
    )
    await closeChildren(page)
    for (let index = 0; index < 4; index += 1) {
      await page.locator('#blank').click()
    }
    await page.evaluate('window.livePopup=window.popup')
    expect(await page.locator('body').getAttribute('data-handle')).toBe('true')
    await page.locator('#blank').click()
    expect(await page.locator('body').getAttribute('data-handle')).toBe('false')
    expect(status().blocked.length).toBeGreaterThanOrEqual(7)
    expect(status().windowsHidden).toBe(true)
    expect(await page.evaluate('Notification.requestPermission()')).toBe('denied')
    await page.evaluate('console.log("orca-popup-fixture:fence")')
    await expect.poll(() => status().routeGranted).toBe(false)
    await expect.poll(() => page.evaluate('window.livePopup.closed')).toBe(true)
    await page.locator('#blank').click()
    expect(await page.locator('body').getAttribute('data-handle')).toBe('false')
    await page.evaluate('console.log("orca-popup-fixture:grant")')
    await expect.poll(() => status().routeGranted).toBe(true)
    await page.locator('#blank').click()
    expect(await page.locator('body').getAttribute('data-handle')).toBe('true')
    const child = browser
      ?.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() === 'about:blank#state')
    if (!child) {
      throw new Error('Missing child for opener-close check')
    }
    await page.evaluate('console.log("orca-popup-fixture:close")')
    await expect.poll(() => child.isClosed()).toBe(true)
  })
})
