/**
 * Hosts whose credential prompt the user cancelled (or left unanswered). Until the user explicitly
 * connects again, no automatic connect may prompt for them: background status checks, managed
 * server tunnels and reconnect ladders would otherwise reopen the modal every few seconds.
 */
const declinedTargets = new Set<string>()

export function recordSshCredentialDeclined(targetId: string): void {
  declinedTargets.add(targetId)
}

export function isSshCredentialDeclined(targetId: string): boolean {
  return declinedTargets.has(targetId)
}

/** Only an explicit user connect (or the target going away) may lift a decline. */
export function clearSshCredentialDeclined(targetId: string): void {
  declinedTargets.delete(targetId)
}

export function resetSshCredentialDeclinesForTests(): void {
  declinedTargets.clear()
}

/** Classified as an auth failure, so callers report "needs sign-in" and never retry it as transient. */
export function createSshCredentialDeclinedError(label: string): Error {
  return Object.assign(
    new Error(`SSH sign-in for ${label} was cancelled. Reconnect to sign in again.`),
    { level: 'client-authentication' }
  )
}
