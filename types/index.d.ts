export type Mode = 'on' | 'off'

export type Severity = 'nit' | 'concern' | 'blocker'

/** The lowest severity that wakes a finished turn, or never. */
export type ContinueSeverity = 'concern' | 'blocker' | 'never'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The options in plugin.json's userConfig, parsed with defaults filled in. */
export type Config = {
  enabled: boolean
  model: string
  effort: Effort
  reviewInterval: number
  continueSeverity: ContinueSeverity
  immuneTurns: number
  maxNotes: number
  maxDeltaChars: number
  timeoutMs: number
  reviewHeadless: boolean
}

/**
 * One piece of captured turn evidence, truncated at capture. `seq` orders it
 * so a finished review removes exactly what it reviewed.
 */
export type Evidence = (
  | { kind: 'prompt'; text: string }
  | { kind: 'continuation' }
  | { kind: 'tool'; id: string; tool: string; input: string; result?: string; isError?: boolean }
  | { kind: 'answer'; text: string }
  | { kind: 'interrupted' }
) & { seq?: number }

export type Note = { severity: Severity; text: string }

/** A note the emission guard has seen, by normalized text. */
export type SeenNote = { key: string; severity: Severity }

export type Stats = {
  reviews: number
  incomplete: number
  quarantined: number
  late: number
  toModel: number
  toPerson: number
  dropped: number
  wakes: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type Running = { runId: string; forTurnId: string | null; generation: number }

/** What the mod keeps for the session. Lives in $.state, so it survives a hot reload. */
export type Session = {
  /** A /watchdog on|off override for this session; null follows the `enabled` option. */
  mode: Mode | null
  /** Bumped by /clear and /watchdog off: a review started under another generation applies nothing. */
  generation: number
  /** Main-loop turns completed this conversation (any reason). */
  mainTurns: number
  /** Answered, non-watchdog main turns: the cadence counter. */
  eligible: number
  /** The running main turn's id, null between turns. */
  turnRunning: string | null
  /** The last main turn that started. */
  lastTurnId: string | null
  /** The last main turn that completed and whether it was interrupted. */
  lastCompleted: { id: string; isAborted: boolean } | null
  /** Who sent the main prompt rows since the last main turn.complete: watchdog's own wake, someone else, or none yet. */
  promptSource: 'watchdog' | 'other' | null
  /** Evidence not yet reviewed, oldest first. */
  evidence: Evidence[]
  /** The next evidence `seq`. */
  nextSeq: number
  running: Running | null
  /** A review was asked for while one ran: run one more after it. */
  rerun: boolean
  /** `mainTurns` when watchdog last woke the agent; null if never. */
  lastWakeTurn: number | null
  seen: SeenNote[]
  stats: Stats
  /** One line on the last review's outcome, for /watchdog status. */
  lastOutcome: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'watchdog': { session: Shaped<Session> }
  }
}
