import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  artifactDir,
  browser,
  closeChildren,
  guest,
  origin,
  receipts,
  snapshots,
  status,
  setPopupFixtureEvidenceName
} from './browser-popup-compatibility-cdp-fixture'

setPopupFixtureEvidenceName('native-electron-evidence.json')

describe('hidden Chromium native popup request compatibility', () => {
  it.each(['local', 'route'])(
    'preserves native Shift POST context, title and policy ordering: %s',
    async (name) => {
      const page = guest(name)
      const before = receipts.length
      await page.evaluate(() => {
        const form = document.querySelector('form')
        if (form) {
          form.target = '_self'
          form.action = '/native-post'
        }
      })
      await page.locator('#post').click({ modifiers: ['Shift'] })
      await expect
        .poll(() => receipts.slice(before).find((receipt) => receipt.path === '/native-post'))
        .toMatchObject({
          method: 'POST',
          body: 'code=synthetic%2Bvalue',
          origin,
          fetchSite: 'same-origin',
          fetchMode: 'navigate',
          fetchDest: 'document',
          fetchUser: '?1',
          referrer: `${origin}/${name}`,
          cookie: `synthetic_session=${name}`,
          proxied: name === 'route'
        })
      await page.evaluate('console.log("orca-popup-fixture:snapshot")')
      await expect
        .poll(() =>
          browser
            ?.contexts()
            .flatMap((context) => context.pages())
            .some((candidate) => candidate.url() === `${origin}/native-post`)
        )
        .toBe(true)
      const child = browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url() === `${origin}/native-post`)
      if (!child) {
        throw new Error('Missing native POST child')
      }
      await child.evaluate(() => {
        document.title = 'Another hostile title'
      })
      if (name === 'route') {
        await page.evaluate('console.log("orca-popup-fixture:snapshot")')
      }
      await expect.poll(() => status().native.windows.at(-1)?.title).toBe(origin)
      expect(status().native.windows.at(-1)).toMatchObject({ fullscreen: false, focused: false })
      if (name === 'route') {
        expect(status().native.creation.at(-1)).toMatchObject({
          firstNavigationPolicy: 'disable_non_proxied_udp',
          firstNavigationTitle: origin,
          firstNavigationOwner: expect.any(Number)
        })
      }
      expect(status().native.requests.at(-1)).toEqual({
        disposition: 'new-window',
        frameName: '',
        features: '',
        post: true
      })
      snapshots.push(status())
      await closeChildren(page)
      for (const id of ['multipart', 'empty']) {
        const beforeBody = receipts.length
        await page.evaluate((id) => {
          const form = document.querySelector(`#${id}`)?.closest('form')
          if (form) {
            form.target = '_self'
            form.action = `/native-${id}`
          }
        }, id)
        await page.locator(`#${id}`).click({ modifiers: ['Shift'] })
        await expect
          .poll(() =>
            receipts.slice(beforeBody).find((receipt) => receipt.path === `/native-${id}`)
          )
          .toMatchObject({
            method: 'POST',
            origin,
            fetchSite: 'same-origin',
            cookie: `synthetic_session=${name}`,
            proxied: name === 'route',
            body: id === 'empty' ? '' : expect.stringContaining('synthetic-multipart'),
            contentType:
              id === 'empty'
                ? 'application/x-www-form-urlencoded'
                : expect.stringMatching(/^multipart\/form-data; boundary=/)
          })
        await expect
          .poll(() =>
            browser
              ?.contexts()
              .flatMap((context) => context.pages())
              .some((candidate) => candidate.url() === `${origin}/native-${id}`)
          )
          .toBe(true)
        await closeChildren(page)
      }
    }
  )

  it.each(['local', 'route'])(
    'withholds cross-site Strict cookies on native and adopted POSTs: %s',
    async (name) => {
      const page = guest(name)
      const targetOrigin = origin.replace('127.0.0.1', 'localhost')
      await page.evaluate((targetOrigin) => {
        const link = document.querySelector('#shift')
        if (link) {
          link.setAttribute('href', `${targetOrigin}/seed`)
        }
      }, targetOrigin)
      await page.locator('#shift').click({ modifiers: ['Shift'] })
      await expect
        .poll(() =>
          browser
            ?.contexts()
            .flatMap((context) => context.pages())
            .some((candidate) => candidate.url() === `${targetOrigin}/seed`)
        )
        .toBe(true)
      for (const child of browser?.contexts().flatMap((context) => context.pages()) ?? []) {
        if (child.url() === `${targetOrigin}/seed`) {
          expect(await child.evaluate('document.cookie')).toContain('strict_cookie=synthetic')
          await child.evaluate('window.close()')
        }
      }
      for (const mode of ['adopted', 'shift', 'no-referrer']) {
        const before = receipts.length
        await page.evaluate(
          ({ targetOrigin, mode }) => {
            const form = document.querySelector('form')
            if (form) {
              form.target = mode === 'adopted' ? '_blank' : '_self'
              form.action = `${targetOrigin}/cross-post`
            }
            if (mode === 'no-referrer') {
              document.querySelector('meta[name=referrer]')?.setAttribute('content', 'no-referrer')
            }
          },
          { targetOrigin, mode }
        )
        await page.locator('#post').click(mode === 'adopted' ? {} : { modifiers: ['Shift'] })
        await expect
          .poll(() => receipts.slice(before).find((receipt) => receipt.path === '/cross-post'))
          .toMatchObject({
            method: 'POST',
            body: 'code=synthetic%2Bvalue',
            origin: mode === 'no-referrer' ? 'null' : origin,
            fetchSite: 'cross-site',
            fetchMode: 'navigate',
            fetchDest: 'document',
            cookie: '',
            referrer: mode === 'no-referrer' ? '' : `${origin}/`,
            proxied: name === 'route'
          })
        await expect
          .poll(() =>
            browser
              ?.contexts()
              .flatMap((context) => context.pages())
              .some((candidate) => candidate.url() === `${targetOrigin}/cross-post`)
          )
          .toBe(true)
        await closeChildren(page)
        await page.evaluate(() =>
          document
            .querySelector('meta[name=referrer]')
            ?.setAttribute('content', 'strict-origin-when-cross-origin')
        )
      }
      expect(status().windowsHidden).toBe(true)
      snapshots.push(status())
    }
  )

  it.each(['local', 'route'])(
    'keeps named, sized and openerless script children adopted: %s',
    async (name) => {
      const page = guest(name)
      for (const [frameName, features] of [
        ['named-synthetic', ''],
        ['named-synthetic', 'width=420,height=260'],
        ['', 'noopener,noreferrer,width=420,height=260']
      ]) {
        const before = receipts.length
        const nativeCount = status().native.creation.length
        await page.evaluate(
          ({ frameName, features }) => {
            document.querySelector('#feature-probe')?.remove()
            const button = document.createElement('button')
            button.id = 'feature-probe'
            button.onclick = () => {
              window.open('/scripted', frameName, features)
            }
            document.body.append(button)
          },
          { frameName, features }
        )
        await page.locator('#feature-probe').click()
        await expect
          .poll(() => receipts.slice(before).some((receipt) => receipt.path === '/scripted'))
          .toBe(true)
        await expect
          .poll(
            () =>
              browser
                ?.contexts()
                .flatMap((context) => context.pages())
                .some((candidate) => candidate.url() === `${origin}/scripted`),
            { timeout: 5_000 }
          )
          .toBe(true)
        expect(status().native.creation.length).toBe(nativeCount)
        await closeChildren(page)
      }
    }
  )

  it.each(['local', 'route'])(
    'retains subframe and opaque initiator metadata on native Shift POSTs: %s',
    async (name) => {
      const page = guest(name)
      const targetOrigin = origin.replace('127.0.0.1', 'localhost')
      for (const opaque of [false, true]) {
        for (const shift of [false, true]) {
          const before = receipts.length
          await page.evaluate(
            ({ targetOrigin, opaque, shift }) => {
              document.querySelector('#frame-probe')?.remove()
              const frame = document.createElement('iframe')
              frame.id = 'frame-probe'
              if (opaque) {
                frame.setAttribute(
                  'sandbox',
                  'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'
                )
              }
              frame.srcdoc = `<form method="post" action="${targetOrigin}/frame-post" target="${shift ? '_self' : '_blank'}"><input name="frame" value="synthetic"><button id="frame-post">POST</button></form>`
              document.body.append(frame)
              if (!document.querySelector('#frame-gesture')) {
                const button = document.createElement('button')
                button.id = 'frame-gesture'
                button.textContent = 'Synthetic gesture'
                document.body.append(button)
              }
            },
            { targetOrigin, opaque, shift }
          )
          if (opaque && name === 'route') {
            // Electron does not forward opaque OOPIF input to the guest's route gesture gate.
            await page.locator('#frame-gesture').click()
          }
          await page
            .frameLocator('#frame-probe')
            .locator('#frame-post')
            .click(shift ? { modifiers: ['Shift'] } : {})
          await expect
            .poll(() => receipts.slice(before).find((receipt) => receipt.path === '/frame-post'))
            .toMatchObject({
              method: 'POST',
              body: 'frame=synthetic',
              origin: opaque ? 'null' : origin,
              fetchSite: 'cross-site',
              cookie: '',
              proxied: name === 'route'
            })
          await expect
            .poll(() =>
              browser
                ?.contexts()
                .flatMap((context) => context.pages())
                .some((candidate) => candidate.url() === `${targetOrigin}/frame-post`)
            )
            .toBe(true)
          await closeChildren(page)
        }
      }
      await page.evaluate(() => document.querySelector('#frame-probe')?.remove())
    }
  )

  it.each(['local', 'route'])(
    'keeps the native origin title through hostile cross-site redirects and fullscreen requests: %s',
    async (name) => {
      const page = guest(name)
      const targetOrigin = origin.replace('127.0.0.1', 'localhost')
      await page.evaluate(() => {
        const form = document.querySelector('form')
        if (form) {
          form.target = '_self'
          form.action = '/native-redirect'
        }
      })
      await page.locator('#post').click({ modifiers: ['Shift'] })
      await expect
        .poll(() =>
          browser
            ?.contexts()
            .flatMap((context) => context.pages())
            .some((candidate) => candidate.url() === `${targetOrigin}/native-final`)
        )
        .toBe(true)
      const child = browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url() === `${targetOrigin}/native-final`)
      if (!child) {
        throw new Error('Missing redirected native child')
      }
      await child.evaluate(() => {
        document.title = 'Synthetic trusted login spoof'
        const button = document.createElement('button')
        button.id = 'fullscreen-probe'
        button.onclick = () => {
          void document.documentElement.requestFullscreen().catch(() => {})
        }
        document.body.append(button)
      })
      await child.locator('#fullscreen-probe').click()
      await (name === 'route'
        ? page.evaluate('console.log("orca-popup-fixture:snapshot")')
        : child.evaluate('document.title="Second synthetic spoof"'))
      await expect.poll(() => status().native.windows.at(-1)?.title).toBe(targetOrigin)
      expect(status().native.windows.at(-1)).toMatchObject({ fullscreen: false, focused: false })
      expect(status().windowsHidden).toBe(true)
      snapshots.push(status())
      if (artifactDir) {
        mkdirSync(artifactDir, { recursive: true })
        await child.screenshot({ path: join(artifactDir, `${name}-hidden-native-redirect.png`) })
      }
      await closeChildren(page)
    }
  )

  it('blocks the first native request when route authority or WebRTC preparation fails during creation', async () => {
    const page = guest('route')
    for (const failure of ['authority', 'authority-error', 'webrtc', 'close']) {
      await page.evaluate(() => {
        const form = document.querySelector('form')
        if (form) {
          form.target = '_self'
          form.action = '/must-not-execute'
        }
      })
      await page.evaluate((failure) => console.log(`orca-popup-fixture:fail-${failure}`), failure)
      const before = status().native.windows.length
      const receiptCount = receipts.length
      await page.locator('#post').click({ modifiers: ['Shift'] })
      await page.evaluate('console.log("orca-popup-fixture:snapshot")')
      await expect.poll(() => status().native.windows.length).toBe(before + 1)
      await expect.poll(() => status().native.windows.at(-1)?.closed).toBe(true)
      expect(
        receipts.slice(receiptCount).some((receipt) => receipt.path === '/must-not-execute')
      ).toBe(false)
      snapshots.push(status())
      await page.evaluate('console.log("orca-popup-fixture:restore-authority")')
      await page.evaluate(() =>
        document
          .querySelector('meta[name=referrer]')
          ?.setAttribute('content', 'strict-origin-when-cross-origin')
      )
    }
  })
})
