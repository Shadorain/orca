import type { InitializeResponse } from './generated/acp-protocol.generated'
import { isBoardMissionEnv, OMP_MISSION_ACP_REQUIRED } from '../../shared/omp-mission-lifecycle'

export { isBoardMissionEnv, OMP_MISSION_ACP_REQUIRED }

/** Agreed with the OMP ACP server: only this key, only the number 1. */
const OMP_MISSION_LIFECYCLE = 'omp.missionLifecycle'

/** True when initialize advertised the mission APIs. Top-level `_meta` is not this marker. */
export function ompMissionLifecycleAdvertised(initialized: InitializeResponse): boolean {
  const meta = initialized.agentCapabilities?._meta
  return meta != null && meta[OMP_MISSION_LIFECYCLE] === 1
}

/**
 * A board mission must see the marker before `session/new`. Ordinary Chat, and any non-OMP
 * agent, is unchanged.
 */
export function ompMissionAcpMissing(
  agent: string,
  env: Readonly<Record<string, string>> | undefined,
  initialized: InitializeResponse
): boolean {
  return agent === 'omp' && isBoardMissionEnv(env) && !ompMissionLifecycleAdvertised(initialized)
}
