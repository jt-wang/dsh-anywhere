// Synthetic wire values, shaped like rc.5 projections; not a substitute for the isolated Gateway acceptance.
import type { TeamTask } from './team-board.ts'
export const fixtureTasks: TeamTask[] = [
  { id: 'plan', revision: 2, subject: 'Review the protocol', description: 'Read the released contract before implementation.', status: 'completed', blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [], ownerId: 'child-review', ownerName: 'reviewer' },
  { id: 'build', revision: 3, subject: 'Implement the native task board', description: 'Read the official projection. Do not recreate the task state machine.', status: 'in_progress', blockedBy: ['plan'], writeScopes: ['src/team-board*'], ready: false, writeScopeWarnings: ['Synthetic overlapping write scope'], ownerId: 'child-build', ownerName: 'builder' },
  { id: 'verify', revision: 1, subject: 'Verify the Gateway', description: 'Wait for implementation before checking the phone boundary.', status: 'pending', blockedBy: ['build'], writeScopes: [], ready: false, writeScopeWarnings: [] },
  { id: 'docs', revision: 1, subject: 'Document acceptance', description: 'A task ready to claim.', status: 'pending', blockedBy: [], writeScopes: ['docs/'], ready: true, writeScopeWarnings: [] },
]
export const fixtureCatalog = [
  { id: 'child-review', createdAt: 1, mode: 'continuable', label: 'Protocol review', name: 'reviewer' },
  { id: 'child-build', createdAt: 2, mode: 'continuable', label: 'Native implementation', name: 'builder' },
  { id: 'external', createdAt: 3, mode: 'external', label: 'External inspection', name: 'inspector' },
]
export function fixtureProjection(mode = 'normal') {
  return { values: mode === 'old' ? {} : { subagentCatalog: fixtureCatalog, agentTeam: { enabled: mode !== 'disabled', tasks: mode === 'empty' ? [] : fixtureTasks,
    ...(mode === 'failure' ? { failure: 'Synthetic rejected team/task revision' } : {}),
  } } }
}
