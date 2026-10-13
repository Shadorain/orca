import { describe, expect, it } from 'vitest'
import { rewriteRelayedPhoneRequest } from '../mobile-desktop-relay/relayed-phone-frames'
import { MOBILE_RPC_METHOD_ROUTES } from './runtime-rpc-mobile-method-routing'

const DESKTOP_TOKEN = 'a'.repeat(48)
const HOST_TOKEN = 'b'.repeat(48)
const VISUAL_READ = {
  path: '/home/me/.orca/scratch/0123456789abcdef0123456789abcdef/chart.html',
  access: { kind: 'chat-visual' }
}

// A phone reads a chat's visual with `files.read` by host path. It must reach the host that runs
// the chat, directly or relayed by its desktop, and arrive there as that host's own request.
describe("a phone's chat visual read by host path", () => {
  it('is an execution-host method, so a phone may call it and a desktop relays it', () => {
    expect(MOBILE_RPC_METHOD_ROUTES.get('files.read')).toBe('execution-host')
  })

  it('crosses the desktop relay with its path and access intact and no routing tag', () => {
    const frame = JSON.stringify({
      id: 'r1',
      deviceToken: DESKTOP_TOKEN,
      executionHost: 'runtime:env-1',
      method: 'files.read',
      params: VISUAL_READ
    })
    // Untagged on arrival: the server serves a path request only when it is the named host.
    expect(JSON.parse(rewriteRelayedPhoneRequest(frame, DESKTOP_TOKEN, HOST_TOKEN))).toEqual({
      id: 'r1',
      method: 'files.read',
      params: VISUAL_READ
    })
  })
})
