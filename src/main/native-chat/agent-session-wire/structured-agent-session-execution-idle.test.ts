// `runWhileExecutionIdle` on a real host: what pins a chat's scratch storage against reclamation,
// and what is only history.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { hostTestAttachParams } from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  foundRestTestChat,
  IDLE_MS,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  REST_TEST_THREAD as THREAD,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

const RETENTION_MS = 30 * 24 * 60 * 60_000

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig()
})

afterEach(async () => {
  await rig.dispose()
})

function fence(): number {
  return rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1
}

function providerEvents() {
  const events = rig.adapter.acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('no provider child was started')
  }
  return events
}

/** Whether the task ran, i.e. nothing the host holds pinned the chat. */
async function reclaimable(sessionId = SESSION): Promise<boolean> {
  const task = vi.fn(async () => 'ran')
  const result = await rig.host.runWhileExecutionIdle(sessionId, task)
  expect(result === 'ran').toBe(task.mock.calls.length === 1)
  return result === 'ran'
}

function lastApprovalRowOnDisk(): string | undefined {
  const rows = rig.host.deps.journalDatabase.db
    .prepare('SELECT row_json FROM journal_rows WHERE session_id = ? ORDER BY ts, seq')
    .all(SESSION)
  return rows
    .map((row) => String(row.row_json))
    .findLast((json) => json.includes('"kind":"approval"'))
}

async function pendingApproval(): Promise<void> {
  providerEvents().appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 70 },
    {
      kind: 'approval',
      title: 'Run the command?',
      detail: null,
      options: [{ id: 'allow', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await rig.host.flushStreamedEvents(SESSION)
}

/** Runs `steps` after the current host "crashes": it is left without its quit flush, so its
 *  child's lease and journal stay as a dead process left them. */
async function withCrashedHost(steps: () => Promise<void>): Promise<void> {
  const crashed = rig.host
  const flushCrashed = crashed.flushAllStreamedEvents.bind(crashed)
  crashed.flushAllStreamedEvents = async () => undefined
  try {
    await steps()
  } finally {
    await flushCrashed().catch(() => undefined)
  }
}

/** The idle sweep puts the agent to rest: no child, lease released on its observed exit. */
async function restChat(): Promise<void> {
  rig.clock.now += IDLE_MS + 1
  await vi.waitFor(() => expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION))
  await vi.waitFor(() => expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released'))
  await vi.waitFor(() => expect(rig.host.hasSession(SESSION)).toBe(false))
}

describe('what pins a chat against storage reclamation', () => {
  it('keeps a chat whose live child runs silently', async () => {
    await foundRestTestChat(rig)
    expect(await reclaimable()).toBe(false)
  })

  it('keeps a chat whose live child waits on an approval past the retention window', async () => {
    await foundRestTestChat(rig)
    await pendingApproval()
    rig.clock.now += RETENTION_MS + 1
    // The idle sweep keeps a child a prompt waits on, so it is still there.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    expect(await reclaimable()).toBe(false)
  })

  it('keeps a chat whose live child waits on a question past the retention window', async () => {
    await foundRestTestChat(rig)
    providerEvents().appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 71 },
      {
        kind: 'question',
        question: 'Which target?',
        options: [{ id: 'web', label: 'Web' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await rig.host.flushStreamedEvents(SESSION)
    rig.clock.now += RETENTION_MS + 1
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    expect(await reclaimable()).toBe(false)
  })

  it('keeps a chat whose child is still starting', async () => {
    const spawn = rig.adapter.acquire.getMockImplementation()!
    rig.adapter.acquire.mockImplementationOnce(async (input) => ({
      ...(await spawn(input)),
      providerChildPhase: 'starting' as const
    }))
    const attached = await rig.host.attach(CALLER, hostTestAttachParams(null))
    expect(attached.ok).toBe(true)
    expect((await rig.host.send(CALLER, restTestSend('first', fence()))).ok).toBe(true)
    await vi.waitFor(() =>
      expect(rig.host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
    )
    expect(await reclaimable()).toBe(false)
  })

  it('keeps a chat whose start was accepted while the reclamation waited for its lock', async () => {
    await foundRestTestChat(rig)
    await restChat()
    expect(await reclaimable()).toBe(true)

    const held = Promise.withResolvers<void>()
    void rig.host['tasks'].serialize(SESSION, () => held.promise)
    const sending = rig.host.send(CALLER, restTestSend('carry on', fence()))
    const reclaim = reclaimable()
    held.resolve()
    expect((await sending).ok).toBe(true)
    expect(await reclaim).toBe(false)
  })

  it('keeps a chat at rest while a delivery runs for it', async () => {
    await foundRestTestChat(rig)
    await restChat()
    const { loop } = rig.host.collaboratorsForTests().conversationDelivery
    vi.spyOn(loop, 'isRunning').mockImplementation((sessionId) => sessionId === SESSION)
    expect(await reclaimable()).toBe(false)
  })

  it('keeps a chat at rest whose provider still holds a send', async () => {
    await foundRestTestChat(rig)
    await restChat()
    rig.adapter.holdsDispatch.mockReturnValue(true)
    expect(await reclaimable()).toBe(false)
  })

  it('keeps a chat at rest whose orchestration dispatch is open', async () => {
    await rig.dispose()
    let open = false
    rig = await createRestTestRig({ hasOpenDispatch: () => open })
    await foundRestTestChat(rig)
    await restChat()
    open = true
    expect(await reclaimable()).toBe(false)
    open = false
    expect(await reclaimable()).toBe(true)
  })

  it('reclaims a chat whose owner recovery released without proof it exited', async () => {
    await foundRestTestChat(rig)
    await restChat()
    // Released with no owner, reservation or handoff: nothing holds it, whatever the proof.
    await rig.store.transitionHandoff(SESSION, (current) => ({
      ...current,
      lease: { ...current.lease, deathEvidence: null }
    }))
    expect(await reclaimable()).toBe(true)
  })

  it('keeps a chat whose held owner cannot be verified after a crash', async () => {
    await foundRestTestChat(rig)
    await withCrashedHost(async () => {
      await rig.restart({
        probeOwner: async () => ({ outcome: 'indeterminate', reason: 'owner cannot be probed' })
      })
      await rig.host.reconcileRestartLeases()
      expect(rig.store.getRecord(SESSION)?.lease).toMatchObject({
        claimStatus: 'live',
        handoffStage: 'recovering'
      })
      expect(rig.host.hasSession(SESSION)).toBe(false)
      expect(await reclaimable()).toBe(false)
    })
  })

  it('does not let a stale pending prompt with no live child pin the chat', async () => {
    await foundRestTestChat(rig)
    await pendingApproval()
    // Orca dies with the child: nothing settles the prompt, and the row stays pending on disk.
    await withCrashedHost(async () => {
      await rig.restart({ probeOwner: async () => ({ outcome: 'pid-absent' }) })
      await rig.host.reconcileRestartLeases()
      expect(rig.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
      expect(rig.host.hasSession(SESSION)).toBe(false)
      expect(lastApprovalRowOnDisk()).toContain('"state":"pending"')
      expect(await reclaimable()).toBe(true)
    })
  })

  it('reclaims a chat whose agent the idle sweep put to rest', async () => {
    await foundRestTestChat(rig)
    await restChat()
    expect(await reclaimable()).toBe(true)
  })

  it('keeps a chat with no readable record', async () => {
    expect(await reclaimable('chat-without-a-record')).toBe(false)
  })

  it('runs nothing once quit has begun', async () => {
    await foundRestTestChat(rig)
    await restChat()
    await rig.host.flushAllStreamedEvents()
    expect(await reclaimable()).toBe(false)
  })
})
