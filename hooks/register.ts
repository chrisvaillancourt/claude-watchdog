import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register } from 'claude-code'

import {
  INITIAL,
  NAME,
  SYSTEM,
  USAGE,
  WAKE_TEXT,
  addEvidence,
  admit,
  answerEvidence,
  buildDelta,
  buildPrompt,
  cleared,
  configFrom,
  decideDelivery,
  evidenceFromRow,
  isActive,
  joinGuidance,
  modelNoteText,
  parseArgs,
  parseReply,
  personNoteText,
  quarantine,
  shouldReview,
  statusText,
} from './policy'
import type { Capture } from './policy'
import type { Config, Evidence, Note, Session, Stats } from '../types'

// Change the shape tag when Session's fields change: a value an older version
// stored (it outlives a hot reload) then reads as INITIAL instead of breaking.
const sessionAtom = atom({ plugin: 'watchdog', key: 'session' } as const, INITIAL, { shape: 'session-2' })

// Module variables reset on a hot reload; register and session.start run
// again then. Anything that must persist goes in $.state.
let config: Config = configFrom({})
let isInteractive = true

/** Best effort: reporting must never throw out of a hook or a timer. */
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(`${NAME}: ${text}`)
  } catch {
    // nothing to do
  }
}

function toast($: EngineInterface, text: string) {
  try {
    $.ui.toast(text, { timeoutMs: 8000 })
  } catch {
    // headless or no surface
  }
}

/** Appends one JSON line to ~/.claude/watchdog/<session id>.jsonl; best effort. */
async function appendLog($: EngineInterface, record: Record<string, unknown>) {
  try {
    const home = await $.env.get('HOME')
    if (!home) return
    const path = `${home}/.claude/watchdog/${await $.session.id()}.jsonl`
    const before = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    const line = JSON.stringify({ ts: new Date(await $.clock.now()).toISOString(), ...record })
    await $.fs.write(path, `${before}${line}\n`)
  } catch {
    // Logging must never stop a review.
  }
}

async function readIfThere($: EngineInterface, path: string): Promise<string> {
  try {
    return (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  } catch {
    return ''
  }
}

/** WATCHDOG.md from the user's ~/.claude, then the project root and its .claude. */
async function loadGuidance($: EngineInterface): Promise<string> {
  const files: { path: string; text: string }[] = []
  try {
    const home = await $.env.get('HOME')
    if (home) files.push({ path: '~/.claude/WATCHDOG.md', text: await readIfThere($, `${home}/.claude/WATCHDOG.md`) })
    const root = await $.session.root()
    files.push({ path: 'WATCHDOG.md', text: await readIfThere($, `${root}/WATCHDOG.md`) })
    files.push({ path: '.claude/WATCHDOG.md', text: await readIfThere($, `${root}/.claude/WATCHDOG.md`) })
  } catch {
    // guidance is optional
  }
  return joinGuidance(files)
}

function addStats(s: Session, change: Partial<Stats>): Session {
  const stats = { ...s.stats }
  for (const [k, v] of Object.entries(change) as [keyof Stats, number][]) stats[k] += v
  return { ...s, stats }
}

function usageStats(u: ModelUsage | undefined): Partial<Stats> {
  if (!u) return {}
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens,
    cacheWriteTokens: u.cache_creation_input_tokens,
  }
}

function isCurrent(s: Session, runId: string, generation: number): boolean {
  return s.running?.runId === runId && s.generation === generation && isActive(config, s)
}

/** Removes the evidence a review covered (every item up to `seq`). */
function consume(s: Session, upTo: number): Session {
  return { ...s, evidence: s.evidence.filter(x => (x.seq ?? -1) > upTo) }
}

async function appendRow($: EngineInterface, type: 'user' | 'system', text: string): Promise<boolean> {
  try {
    const r = await $.session.append({ message: { type, content: [{ type: 'text', text }] } })
    return r.deny === undefined
  } catch (err) {
    log($, `could not append a ${type === 'user' ? 'note for the model' : 'notice'}: ${String(err)}`)
    return false
  }
}

async function showPerson($: EngineInterface, notes: readonly Note[], late: boolean) {
  const text = personNoteText(notes, late)
  if (!(await appendRow($, 'system', text))) log($, text)
  toast($, text.replace(/^watchdog:\s*/, ''))
}

/**
 * Starts a review of the evidence waiting, for the turn `forTurnId`, unless
 * one runs (then one more follows it). Returns a line saying what it did.
 */
async function startReview($: EngineInterface, forTurnId: string | null, inline: boolean): Promise<string> {
  const s = await read($, sessionAtom)
  if (!isActive(config, s)) return 'watchdog is off.'
  if (s.running) {
    await update($, sessionAtom, cur => ({ ...cur, rerun: true }))
    return 'A review is running; another will follow it.'
  }
  if (s.evidence.length === 0) return 'Nothing new to review.'
  const runId = `${await $.clock.now()}-${Math.random().toString(36).slice(2, 8)}`
  const items = s.evidence
  const upTo = Math.max(...items.map(x => x.seq ?? -1))
  await update($, sessionAtom, cur => ({ ...cur, running: { runId, forTurnId, generation: s.generation }, rerun: false }))
  try {
    await review($, runId, s.generation, forTurnId, items, upTo, inline)
  } catch (err) {
    log($, `review failed: ${String(err)}`)
  } finally {
    const after = await update($, sessionAtom, cur => (cur.running?.runId === runId ? { ...cur, running: null } : cur))
    if (after.rerun && after.running === null && isActive(config, after) && !inline) {
      $.clock.after(0, () => void startReview($, after.lastTurnId, false))
    }
  }
  return `Reviewing ${items.length} evidence items.`
}

async function review(
  $: EngineInterface,
  runId: string,
  generation: number,
  forTurnId: string | null,
  items: readonly Evidence[],
  upTo: number,
  inline: boolean,
) {
  const delta = buildDelta(items, config.maxDeltaChars)
  const guidance = await loadGuidance($)
  const result = await $.model.complete({
    model: config.model,
    system: SYSTEM,
    prompt: buildPrompt(guidance, delta),
    maxTokens: 1024,
    effort: config.effort,
    timeoutMs: config.timeoutMs,
  })
  const usage: ModelUsage | undefined = 'usage' in result ? result.usage : undefined
  const logBase = { kind: 'review', turnId: forTurnId, model: config.model, ...usageStats(usage), items: items.length }

  const s = await read($, sessionAtom)
  if (!isCurrent(s, runId, generation)) {
    await appendLog($, { ...logBase, outcome: 'discarded' })
    log($, 'a review finished after watchdog was turned off or the conversation cleared; discarded')
    return
  }
  const notes = result.isAnswered ? parseReply(result.text) : null
  if (notes === null) {
    const reason = result.isAnswered ? 'the reply had no <notes> block' : result.reason
    await update($, sessionAtom, cur => ({ ...addStats(cur, { reviews: 1, incomplete: 1, ...usageStats(usage) }), lastOutcome: `incomplete (${reason}); the evidence is kept for the next review.` }))
    await appendLog($, { ...logBase, outcome: 'incomplete', reason, ...(result.isAnswered ? { reply: result.text.slice(0, 2000) } : {}) })
    log($, `review incomplete: ${reason}`)
    return
  }
  const hazard = quarantine(notes, delta)
  if (hazard) {
    await update($, sessionAtom, cur => ({ ...consume(addStats(cur, { reviews: 1, quarantined: 1, ...usageStats(usage) }), upTo), lastOutcome: `quarantined (${hazard}); nothing delivered.` }))
    await appendLog($, { ...logBase, outcome: 'quarantined', reason: hazard, notes: notes.length })
    await appendRow($, 'system', `watchdog: quarantined a review reply (${hazard}); nothing from it was delivered.`)
    return
  }
  const admitted = admit(notes, s.seen, config.maxNotes)
  await update($, sessionAtom, cur => ({
    ...consume(addStats(cur, { reviews: 1, dropped: admitted.dropped, ...usageStats(usage) }), upTo),
    seen: admitted.seen,
  }))
  if (admitted.kept.length === 0) {
    await update($, sessionAtom, cur => ({ ...cur, lastOutcome: `no notes (${admitted.dropped} dropped by the guard).` }))
    await appendLog($, { ...logBase, outcome: 'quiet', kept: 0, dropped: admitted.dropped, ...(result.isAnswered ? { reply: result.text.slice(0, 2000) } : {}) })
    return
  }

  const interactive = isInteractive && !inline
  // Decide from the facts right before delivering: /watchdog off, /clear or a
  // newer turn may have landed while the admission write was in flight.
  const fresh = await read($, sessionAtom)
  if (!isCurrent(fresh, runId, generation)) {
    await appendLog($, { ...logBase, outcome: 'discarded', notes: admitted.kept })
    log($, 'a review was discarded before delivery: watchdog was turned off or the conversation cleared')
    return
  }
  const d = decideDelivery(fresh, forTurnId, admitted.kept, config, interactive)
  if (d.toModel.length > 0 && !(await appendRow($, 'user', modelNoteText(d.toModel)))) {
    // The model couldn't be told: show the person instead, so nothing is lost silently.
    d.toPerson.push(...d.toModel)
    d.toModel = []
    d.wake = false
  }
  if (d.toPerson.length > 0) {
    if (isCurrent(await read($, sessionAtom), runId, generation)) await showPerson($, d.toPerson, d.late)
    else log($, 'a review was turned off before its notice could be shown')
  }
  await update($, sessionAtom, cur => addStats(cur, { toModel: d.toModel.length, toPerson: d.toPerson.length, late: d.late ? d.toPerson.length : 0 }))

  let woke = false
  if (d.wake) {
    // Decide again from the facts now: a turn may have started while the notes were appended.
    const now = await read($, sessionAtom)
    if (isCurrent(now, runId, generation) && decideDelivery(now, forTurnId, admitted.kept, config, interactive).wake) {
      try {
        const r = await $.prompt.submit({ text: WAKE_TEXT })
        woke = !('drop' in r && r.drop !== undefined)
      } catch (err) {
        log($, `wake refused: ${String(err)}`)
      }
      if (woke) await update($, sessionAtom, cur => ({ ...addStats(cur, { wakes: 1 }), lastWakeTurn: cur.mainTurns }))
    }
  }
  const summary = `${admitted.kept.length} notes (${d.toModel.length} to the model, ${d.toPerson.length} to you${d.late ? ', late' : ''})${woke ? '; woke the agent' : ''}.`
  await update($, sessionAtom, cur => ({ ...cur, lastOutcome: summary }))
  await appendLog($, { ...logBase, outcome: d.late ? 'late' : 'delivered', notes: admitted.kept, kept: admitted.kept.length, dropped: admitted.dropped, toModel: d.toModel.length, toPerson: d.toPerson.length, wake: woke })
  log($, summary)
}

/** Records what a main-conversation row adds to the evidence. */
async function capture($: EngineInterface, door: string, row: { content: readonly unknown[] }, origin: { kind: string; name?: string }) {
  if (door === 'prompt') {
    const source: Session['promptSource'] = origin.kind === 'plugin' && origin.name === NAME ? 'watchdog' : 'other'
    await update($, sessionAtom, cur => (cur.promptSource === 'other' ? cur : { ...cur, promptSource: source }))
  }
  const s = await read($, sessionAtom)
  if (!isActive(config, s)) return
  const found: Capture[] = evidenceFromRow(door, row, origin)
  if (found.length === 0) return
  await update($, sessionAtom, cur => {
    let seq = cur.nextSeq
    const numbered = found.map(c => (c.kind === 'result' ? c : { ...c, seq: seq++ }))
    return { ...cur, evidence: addEvidence(cur.evidence, numbered), nextSeq: seq }
  })
}

export const register: Register = (on, options) => {
  config = configFrom(options)

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    // A review that ran in an environment a reload dropped will never finish.
    await update($, sessionAtom, s => (s.running ? { ...s, running: null } : s))
    await $.command.register({
      name: 'watchdog',
      description: 'Background reviewer: on, off, status, or review now',
      argumentHint: '[on|off|status|review]',
    })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, sessionAtom, cleared)
    return next(e)
  })

  on('command.run', { command: 'watchdog' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (cmd.kind === 'set') {
      await update($, sessionAtom, s =>
        cmd.mode === 'on' ? { ...s, mode: 'on' as const } : { ...s, mode: 'off' as const, generation: s.generation + 1, running: null, rerun: false, evidence: [] },
      )
    }
    if (cmd.kind === 'review') {
      const s = await read($, sessionAtom)
      if (!isActive(config, s)) return { text: 'watchdog is off for this session; /watchdog on first.' }
      if (s.running) {
        await update($, sessionAtom, cur => ({ ...cur, rerun: true }))
        return { text: 'A review is running; another will follow it.' }
      }
      if (s.evidence.length === 0) return { text: 'Nothing new to review.' }
      $.clock.after(0, () => void startReview($, s.lastTurnId, false))
      return { text: `Reviewing ${s.evidence.length} evidence items now.` }
    }
    return { text: statusText(config, await read($, sessionAtom), isInteractive) }
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    // Main conversation only; the plugin's own rows and notices are not evidence.
    if (e.agentId === undefined && e.door !== 'note' && e.door !== 'notice') {
      try {
        await capture($, e.door, stored.message ?? e.message, e.origin as { kind: string; name?: string })
      } catch (err) {
        log($, `capture failed: ${String(err)}`)
      }
    }
    return stored
  }).catch(($, e, next) => next(e)) // fail open: capture never costs a row

  on('turn.start', async ($, e, next) => {
    // Subagent loops carry agentId; watchdog follows the main conversation only.
    if (e.agentId === undefined) await update($, sessionAtom, s => ({ ...s, turnRunning: e.turnId, lastTurnId: e.turnId }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const before = await read($, sessionAtom)
    const active = isActive(config, before)
    const isContinuation = before.promptSource === 'watchdog'
    const counts = e.reason === 'answer' && !isContinuation
    const s = await update($, sessionAtom, cur => {
      let seq = cur.nextSeq
      const extra: Evidence[] = !active ? [] : e.reason === 'answer' ? answerEvidence(e.answer) : e.isAborted ? [{ kind: 'interrupted' }] : []
      const numbered = extra.map(x => ({ ...x, seq: seq++ }))
      return {
        ...cur,
        mainTurns: cur.mainTurns + 1,
        eligible: counts ? cur.eligible + 1 : cur.eligible,
        turnRunning: cur.turnRunning === e.turnId ? null : cur.turnRunning,
        lastCompleted: { id: e.turnId, isAborted: e.isAborted },
        promptSource: null,
        evidence: addEvidence(cur.evidence, numbered),
        nextSeq: seq,
      }
    })
    if (active && counts && shouldReview(config, s.eligible)) {
      if (isInteractive) $.clock.after(0, () => void startReview($, e.turnId, false))
      else if (config.reviewHeadless) {
        try {
          await startReview($, e.turnId, true)
        } catch (err) {
          log($, `review failed: ${String(err)}`)
        }
      }
    }
    return next(e)
  })
}
