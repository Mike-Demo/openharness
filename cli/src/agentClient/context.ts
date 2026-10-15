/**
 * Where an agent is and what it may do, said before it acts (docs/design/2026-10-15-agent-experience.md, part 1).
 * Pure: commands.ts gathers what it says.
 */

/** Which limit refuses a start (commands.ts `spawnCheck`). */
export type SpawnReason = 'DEPTH' | 'OPEN_LIMIT' | 'MACHINE_LIMIT' | 'START_RATE'

/** What the limits count for one caller: its open harnesses, its starts in the window, its depth. */
export interface SpawnCount { open: number; starts: number; depth: number; oldestStartAt: number | null }
