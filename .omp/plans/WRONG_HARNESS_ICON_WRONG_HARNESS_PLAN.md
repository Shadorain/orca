# Wrong harness icon after a brief Codex open

## Context

GitHub #24854: the user only runs OMP, accidentally opened Codex, closed it immediately, and started OMP. Hours later the worktree card (`omp-mission`, host badge "Daedalus") still shows one compact agent row: green done dot, Codex icon, text `Done - Codex`, timestamp `2h`. Switching workspaces and refreshing does not replace that icon with the harness that is actually running.

`Done - Codex` is `getCompactAgentLineOrder` in `src/renderer/src/components/sidebar/worktree-card-compact-agent-row.tsx`: primary falls back to `agentStateLabel('done')` when prompt and conversation name are empty, secondary falls back to `formatAgentTypeLabel('codex')`. The `2h` stamp comes from `lastEnteredDoneAt` / `startedAt` on a live or retained hook row. A title-derived row stamps `startedAt: 0` and `entry.stateStartedAt: now`, so it cannot be the row in the screenshot.

End state: that pane's card row and tab icon show the harness that is actually running (OMP), including after a refresh. A task title that only mentions Codex does not put the Codex icon back. A finished session on a different pane stays listed. Pi nested under OMP still displays as OMP.

## Approach

Do not unify the title parsers or move ranking into `resolveCanonicalPaneAgentIdentity`. Those are #26513. This change only stops a finished harness from occupying a pane a later harness already owns, and stops a free-text name from overriding that owner.

### 1. A live process of a different family retires the finished snapshot

Add `src/renderer/src/components/sidebar/retire-stale-harness-snapshot.ts` with:

```ts
export function shouldRetireFinishedHarnessSnapshot(args: {
  finishedAgent: AgentType | null | undefined
  finishedState: 'done' | 'other'
  foreground: TitleDerivedPaneForeground | undefined
  launchAgent: AgentType | null | undefined
  title: string
  defaultTitle?: string
}): boolean
```

Return true only when all of these hold:

- `finishedState === 'done'`
- `foreground.agentEvidence === 'process-read'`
- `foreground.agent` is a non-null `AgentType`
- `titleRetiresProcessRead({ title, defaultTitle })` from `title-derived-pane-agent-identity.ts` is false (export it if it is still file-private; do not copy it)
- `shareCompatibleTitleIdentityGroup(finishedAgent, foreground.agent)` is false
- also false when `shareCompatibleTitleIdentityGroup(finishedAgent, launchAgent)` is true and `shareCompatibleTitleIdentityGroup(launchAgent, foreground.agent)` is true (OMP launch + Pi process must not retire an OMP done row)

Call it from the existing publish path in `src/renderer/src/components/terminal-pane/pty-connection/pane-agent-identity.ts` immediately after `setPaneForegroundAgent(session.cacheKey, entry)`, and from the other `setPaneForegroundAgent` calls in that file that publish a `process-read`. Do not call it from `launch-record` publishes.

When it returns true for the pane's live `agentStatusByPaneKey` entry or its `retainedAgentsByPaneKey` entry:

- `dismissRetainedAgent(paneKey)`
- if the live entry exists and `entry.state === 'done'`, `dropAgentStatus(paneKey)` (existing action; it already drops the host's persisted row, so a refresh does not resurrect Codex)
- do not drop a `working`, `waiting`, `blocked`, or `permission` entry

`buildWorktreeAgentRows` must agree even before that side effect runs. In the live-entry loop (`worktree-agent-rows.ts` around the `explicitEntries` walk) and the retained loop, skip a `done` row when `shouldRetireFinishedHarnessSnapshot` is true for that pane. Do not add its paneKey to `seenPaneKeys`. Title-derived then emits the process occupant, which already outranks launch in `resolveTitleDerivedPaneAgent`. A done row of the same family, a row with no process read, and a row whose title is a shell or the tab default stay as they are.

### 2. A typed shell command of a different family replaces the launch latch

`rememberCommandInferredPaneAgent` in `command-inferred-pane-agent.ts` sets `commandInferredPaneAgent` to null whenever `agentLaunchConfigByPaneKey[paneKey].identity.agentType` is any TUI agent or any foreground agent is set. That veto is why typing `omp` after an Orca-launched Codex never becomes identity.

Replace the veto with: suppress the typed candidate only when the pane is not at a shell. The pane is at a shell when `paneForegroundAgentByPaneKey[paneKey].shellForeground === true`, or the live title is empty / `titleShowsNoAgent(title, tab.defaultTitle)`, or there is no foreground agent and the hook entry is missing or `state === 'done'`. Keystrokes inside a live TUI (`shellForeground === false` and a fresh non-done hook or a process-read agent) still do not retarget.

When the candidate is accepted and `!shareCompatibleTitleIdentityGroup(candidate, currentLaunch)` (`currentLaunch` is `tab.launchAgent ?? registeredLaunchAgent`):

- keep `session.commandInferredPaneAgent = candidate` and the existing `startAcceptedInferredCommand(candidate)` call
- add `replaceTabLaunchAgent(tabId, agent: TuiAgent)` next to `clearTabLaunchAgent` in `terminal-tab-presentation.ts` and on `TerminalActions`. It no-ops when the tab is missing or `launchAgent` is already `agent`. Otherwise it sets `tab.launchAgent` and calls `scheduleRuntimeGraphSync()`, same as `clearTabLaunchAgent`. Do not add a second launch-agent writer.
- `clearAgentLaunchConfig(paneKey)`. Do not call `registerAgentLaunchConfig` with an empty config; the old Codex resume args must not be reused under the new identity.
- run the same retire calls as step 1 for that paneKey

Typing `pi` while `launchAgent` is `omp` does not replace the latch (`shareCompatibleTitleIdentityGroup` is true). Typing `omp` while the latch is `codex` does.

`resolveTitleDerivedPaneOwner` already reads `tab.launchAgent` on a single-leaf tab, and `normalizeCompatibleAgentTitleForOwner` already rewrites a Pi frame to the OMP label when that latch is `omp`. No new ranking.

### 3. A free-text name does not override a known owner

`resolveTitleDerivedAgentType` in `title-derived-pane-agent-identity.ts` returns the label's agent immediately for every non-Claude label. `getAgentLabel('Done - Codex')` is `Codex`, so a title that only mentions Codex takes the pane from an OMP owner. That ranks above launch in `resolveTitleDerivedPaneAgent`.

After the existing Claude identity-frame checks, if `ownerAgentType` is set and `!shareCompatibleTitleIdentityGroup(ownerAgentType, labelAgent)`:

- call `collectAgentTitleEvidence(title)`
- return `labelAgent` only when `reason` is `'vendor-marker'` or `'anchored'` and `evidence.agent === labelAgent`
- otherwise return null

No owner: keep today's label mapping, so a bare `Codex` title on an empty pane still fills the slot.

Apply the same strength check to title reclaim in both tab-icon copies, so the tab icon cannot disagree with the card:

- `resolveTabAgentFromSignals` in `src/renderer/src/lib/use-tab-agent.ts`
- `resolveTabAgentFromSignals` in `src/renderer/src/lib/tab-agent-from-signals.ts`

`titleReclaimsReusedPane` becomes true only when the existing conditions hold and `collectAgentTitleEvidence(args.title)` has `reason` `'vendor-marker'` or `'anchored'` with `agent === explicitTitleAgent`. A free-text name does not reclaim. An empty slot still accepts `explicitTitleAgent` (the existing final branch). Do not delete either copy.

SSH and paired web clients often have no process read. They still update when a hook arrives (already a different family in `resolveRowAgentType`) or when step 3 stops a mention from overriding the owner. Do not add a remote process scanner or a new wire field. If neither a process read, a hook, nor a strong title exists, the latch stays until one of those arrives.

## Critical files & anchors

- `src/renderer/src/components/sidebar/worktree-agent-rows.ts` `buildWorktreeAgentRows` — skip a done row whose pane has a different-family process read; do not mark that paneKey seen.
- `src/renderer/src/components/sidebar/title-derived-pane-agent-identity.ts` `resolveTitleDerivedAgentType` — free-text mention must not beat a known owner.
- `src/renderer/src/components/terminal-pane/pty-connection/command-inferred-pane-agent.ts` `rememberCommandInferredPaneAgent` — shell-only veto, then replace the latch.
- `src/renderer/src/store/terminals/terminal-tab-presentation.ts` `clearTabLaunchAgent` — add `replaceTabLaunchAgent` beside it.
- `src/renderer/src/lib/use-tab-agent.ts` and `src/renderer/src/lib/tab-agent-from-signals.ts` `titleReclaimsReusedPane` — same strength gate.

## Verification

Unit, from the worktree:

`pnpm test src/renderer/src/components/sidebar/worktree-title-derived-agent-rows.test.ts src/renderer/src/components/sidebar/useWorktreeAgentRows.test.ts src/renderer/src/lib/use-tab-agent.test.ts src/renderer/src/lib/tab-agent-from-signals.test.ts`

Add these cases to the existing files (no new throwaway script):

- `useWorktreeAgentRows.test.ts`: live done entry `{ agentType: 'codex', state: 'done', prompt: '' }` plus `paneForegroundAgentByPaneKey` process-read `omp` and a non-shell title yields one row with `agentType === 'omp'`, not a done Codex row. Same-family Pi process on an OMP done row does not drop it. No foreground map still yields the done Codex row.
- `worktree-title-derived-agent-rows.test.ts`: `resolveTitleDerivedAgentType('Done - Codex', 'Codex', 'omp')` is null. `resolveTitleDerivedAgentType('Codex', 'Codex', null)` is `'codex'`. A vendor-marker or anchored Codex title with owner `omp` still returns `'codex'`.
- `use-tab-agent.test.ts`: `resolveTabAgentFromSignals` with `launchAgent: 'omp'`, no hook, title `'Done - Codex'` returns `'omp'`, not `'codex'`.

Command-inference: extend the existing pty-connection test that covers `rememberCommandInferredPaneAgent` (search `commandInferredPaneAgent` under `src/renderer/src/components/terminal-pane/`). A registered Codex launch config plus `shellForeground: true` and a typed `omp` sets `commandInferredPaneAgent` to `'omp'` and calls `replaceTabLaunchAgent`. The same typed `omp` with `shellForeground: false` and a fresh working hook does not.

## Assumptions & contingencies

- The screenshot row is a done Codex hook or retained snapshot, not a title-derived row. If a reproduction shows a title-derived row (`startedAt === 0`) whose title is an anchored Codex identity, step 3 correctly keeps Codex; do not special-case that title.
- `dropAgentStatus` already evicts the host persisted row. If the implementation finds it does not, call the existing `window.api.agentStatus.dropPersisted` with that entry's cache identity from the same retire function. Do not add a new IPC channel.
- Paired web clients without a process read will not flip until a hook or a strong title arrives. That is the intended limit; do not publish a new snapshot field in this change.
