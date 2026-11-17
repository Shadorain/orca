import { afterEach, describe, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { failedAcquisitionSettlement } from '../native-chat/agent-session-wire/structured-agent-session-failed-create-refusal'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { openAcpAdapterRig } from './acp-structured-adapter.test-support'
import { OMP_MISSION_ACP_REQUIRED } from '../../shared/omp-mission-lifecycle'
import { ompMissionAcpMissing, ompMissionLifecycleAdvertised } from './omp-mission-lifecycle'
import type { InitializeResponse } from './generated/acp-protocol.generated'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const OMP = acpLaunchSpecFor('omp')!
const READY: InitializeResponse = {
  protocolVersion: 1,
  agentCapabilities: { _meta: { omp: { missionLifecycle: 1 } } }
}
const MARKED: InitializeResponse = {
  protocolVersion: 1,
  agentCapabilities: { _meta: { 'omp.missionLifecycle': 1 } }
}

describe('OMP mission initialize marker', () => {
  it('accepts only agentCapabilities._meta omp.missionLifecycle === 1', () => {
    expect(ompMissionLifecycleAdvertised(MARKED)).toBe(true)
    expect(ompMissionLifecycleAdvertised(READY)).toBe(false)
    expect(
      ompMissionLifecycleAdvertised({
        protocolVersion: 1,
        _meta: { omp: { missionLifecycle: 1 } }
      })
    ).toBe(false)
    expect(ompMissionAcpMissing('omp', { OMP_HOLOTABLE_CHILD: '1' }, MARKED)).toBe(false)
    expect(ompMissionAcpMissing('omp', { OMP_MISSION_AUTOSTART: '1' }, READY)).toBe(true)
    expect(ompMissionAcpMissing('omp', { OMP_MISSION_AUTOSTART: '' }, READY)).toBe(false)
    expect(ompMissionAcpMissing('omp', {}, READY)).toBe(false)
    expect(ompMissionAcpMissing('grok', { OMP_HOLOTABLE_CHILD: '1' }, READY)).toBe(false)
  })

  it('does not call session/new when an old OMP is asked to run a board mission', async () => {
    const rig = await openAcpAdapterRig({
      spec: OMP,
      launch: { env: { OMP_HOLOTABLE_CHILD: '1', OMP_MISSION_AUTOSTART: 'mission-1' } }
    })
    const started = rig.acquire()
    await expect(started).rejects.toThrow(OMP_MISSION_ACP_REQUIRED)
    expect(rig.sent('session/new')).toEqual([])
    expect(rig.sent('session/load')).toEqual([])
    expect(rig.sent('initialize').length).toBeGreaterThan(0)
  })

  it('starts an ordinary old OMP chat and a marked board mission', async () => {
    const ordinary = await openAcpAdapterRig({ spec: OMP, launch: { env: { PATH: '/usr/bin' } } })
    await ordinary.acquire()
    expect(ordinary.sent('session/new')).toHaveLength(1)

    const marked = await openAcpAdapterRig({
      spec: OMP,
      launch: { env: { OMP_MISSION_AUTOSTART: 'mission-1' } },
      initialize: {
        agentCapabilities: { loadSession: true, _meta: { 'omp.missionLifecycle': 1 } }
      }
    })
    await marked.acquire()
    expect(marked.sent('session/new')).toHaveLength(1)
  })

  it('keeps the actionable sentence on the launch refusal', () => {
    const settled = failedAcquisitionSettlement(
      new AgentSessionAcquisitionRefusal(OMP_MISSION_ACP_REQUIRED),
      { record: null, newSession: true }
    )
    expect(settled.outcome.message).toBe(OMP_MISSION_ACP_REQUIRED)
    expect(settled.outcome.status).toBe('failed')
  })
})
