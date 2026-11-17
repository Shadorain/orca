/** Board mission launches. Ordinary Chat does not set either key. */
export function isBoardMissionEnv(env: Readonly<Record<string, string>> | undefined): boolean {
  if (!env) {
    return false
  }
  return env.OMP_HOLOTABLE_CHILD === '1' || (env.OMP_MISSION_AUTOSTART ?? '').length > 0
}

/** What a board sees when an old OMP initialize omits the mission marker. */
export const OMP_MISSION_ACP_REQUIRED = 'requires OMP native mission ACP APIs'
