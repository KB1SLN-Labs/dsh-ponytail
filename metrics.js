// metrics.js — the `ponytailStats` session-projection unit plus the read-only
// effective-state Fetch route for the approved native UI.
//
// Same definition shape as @deepseek-ai/dsh-session-stats (key / stateVersion /
// stateSchema / init(header, inheritedEventCount) / pure apply / wire.viewSchema+
// wire.view), so the host projection registry drives it exactly like its own unit.
//
// What this fold counts — and what it deliberately does NOT:
//   * Minimal counters only: inputTokens, outputTokens, cacheReadTokens,
//     cacheWriteTokens, usageReports, turns, activeMs, openTurnStart,
//     inheritedEventCount.
//   * `inputTokens` is the provider's own input figure. The cache fields are
//     SEPARATE subsets of provider traffic and are NEVER added into the input
//     total (the host's own token-meter keeps the same separation).
//   * NO monetary savings and NO estimated price — nothing here converts tokens
//     into money, and no pricing table is consulted.
//   * TESTS: this fold does NOT track tests at all — no pass/fail detection from
//     prose, tool output, or any other text inside the fold. The live process keeps
//     an in-memory "last recorded test command" band instead (see `recordedTestResult`
//     below and index.js): a recorded command EXIT is evidence for that command only,
//     it is lost on restart, and there is no historical test status on the wire. The
//     first UI labels that row 'Not recorded this process'. Documented here so the
//     absence of history is explicit, not an oversight.
//   * A fork's inherited prefix (event.seq < inheritedEventCount) is skipped:
//     the seed events were already billed in the parent session, so they must
//     not be billed twice in the child. The host supplies the exact cut to
//     init(); this unit never infers it from firstLiveSeq or session/end-seed.
//   * Every actual event is counted exactly once because the registry performs
//     one host-sequenced fold per event. Each attempt settles EXACTLY ONE of
//     `assistant/message` (success, which carries `usage` directly) or
//     `assistant/attempt` (failure / error / interrupted-without-content, whose
//     data carries ONLY `stream` — verified in dsh-agent-loop lib/index.js lines
//     1090-1170). So one step contributes once, and a failed attempt's usage is
//     recovered from the last embedded raw `usage` chunk of its stream. Retried
//     failures are separate events and each paid for its own tokens — that is the
//     honest billed-attempt count, not a bug to hide. Direct `data.usage` and the
//     stream-derived usage are NEVER both added for one event.
//   * Usage fields are accepted only when they are safe nonnegative integers
//     (`Number.isSafeInteger` && >= 0); anything else (missing, NaN, Infinity,
//     negative, fractional, wrong type) is ignored field by field — the counters
//     are int() schemas, so a fractional value would be invalid state.
//     usageReports increments only when at least one of input/output is present.
//   * Turn time: turn/start opens a turn, turn/end closes it with a delta
//     clamped to >= 0 and increments turns. A turn/end with no open turn does
//     NOT invent time (and an orphan turn/start stays open until the next one).

import { z } from 'zod'
// Canonical embedded-Assistant-stream reader (required host peer): scans backwards
// for the last raw chunk of one type. Used ONLY to recover a failed attempt's usage
// from its `stream`, never to re-count a settled message's own direct usage.
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm'

export const PONYTAIL_STATE_PATH = '/api/ponytail/state'

/** One provider-reported usage record, guarded field by field. */
function countersFromUsage(usage) {
  const value = (record, key) => {
    if (record === null || typeof record !== 'object') return null
    const candidate = record[key]
    // Token counts must be safe nonnegative integers: the counters are int()
    // schemas, so a fractional number would create invalid state and is ignored.
    return typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : null
  }
  const inputTokens = value(usage, 'inputTokens')
  const outputTokens = value(usage, 'outputTokens')
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: value(usage, 'cacheReadTokens'),
    cacheWriteTokens: value(usage, 'cacheWriteTokens'),
    // A usage report only counts as a report when the provider actually reported
    // at least one of the two billed sides.
    usageReports: inputTokens !== null || outputTokens !== null ? 1 : 0,
  }
}

/** Add only the fields that were present and valid; totals stay nonnegative. */
function addCounters(state, counters) {
  const next = { ...state }
  if (counters.inputTokens !== null) next.inputTokens += counters.inputTokens
  if (counters.outputTokens !== null) next.outputTokens += counters.outputTokens
  // Cache traffic is tracked in its own buckets — never folded into inputTokens.
  if (counters.cacheReadTokens !== null) next.cacheReadTokens += counters.cacheReadTokens
  if (counters.cacheWriteTokens !== null) next.cacheWriteTokens += counters.cacheWriteTokens
  next.usageReports += counters.usageReports
  return next
}

const counterSchema = z.number().int().nonnegative()

const ponytailStatsStateSchema = z.object({
  inputTokens: counterSchema,
  outputTokens: counterSchema,
  cacheReadTokens: counterSchema,
  cacheWriteTokens: counterSchema,
  usageReports: counterSchema,
  turns: counterSchema,
  activeMs: z.number().nonnegative(),
  openTurnStart: z.number().nonnegative().nullable(),
  inheritedEventCount: counterSchema,
}).strict()

/** The public wire view: totals plus the open-turn marker and report count. */
const ponytailStatsViewSchema = z.object({
  inputTokens: counterSchema,
  outputTokens: counterSchema,
  cacheReadTokens: counterSchema,
  cacheWriteTokens: counterSchema,
  usageReports: counterSchema,
  turns: counterSchema,
  activeMs: z.number().nonnegative(),
  openTurnStart: z.number().nonnegative().nullable(),
}).strict()

/**
 * The `ponytailStats` projection unit. Registered by index.js through an
 * OPTIONAL ctx.inject(['sessionProjections'], …), so a headless composition
 * without the registry is unaffected.
 */
export const ponytailStatsProjectionDefinition = {
  key: 'ponytailStats',
  stateVersion: 1,
  stateSchema: ponytailStatsStateSchema,
  init: (_header, inheritedEventCount = 0) => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    usageReports: 0,
    turns: 0,
    activeMs: 0,
    openTurnStart: null,
    inheritedEventCount: typeof inheritedEventCount === 'number' && Number.isFinite(inheritedEventCount) && inheritedEventCount >= 0 ? Math.trunc(inheritedEventCount) : 0,
  }),
  apply: (state, event) => {
    // Registry contract: unrelated events return the SAME reference.
    if (event.type !== 'assistant/attempt' && event.type !== 'assistant/message' && event.type !== 'turn/start' && event.type !== 'turn/end') return state
    // Fork seed events were billed in the parent session; skip them here so the
    // child's fold never bills the same usage twice.
    if (typeof event.seq === 'number' && event.seq < state.inheritedEventCount) return state
    switch (event.type) {
      case 'assistant/attempt':
      case 'assistant/message': {
        // Each attempt settles exactly one of these two events, so the fold adds
        // ONE usage per event. A settled `assistant/message` carries direct
        // `data.usage`; a failed `assistant/attempt` carries ONLY `stream`, and
        // its usage is the last embedded raw usage chunk (dsh-llm's own reader).
        // The `??` keeps it to one source per event — never both.
        const usage = event.data?.usage
          ?? (Array.isArray(event.data?.stream) ? lastAssistantStreamChunk(event.data.stream, 'usage')?.usage : undefined)
        const counters = countersFromUsage(usage)
        if (counters.usageReports === 0
          && counters.inputTokens === null
          && counters.outputTokens === null
          && counters.cacheReadTokens === null
          && counters.cacheWriteTokens === null) return state
        return addCounters(state, counters)
      }
      case 'turn/start':
        // A second open without a close replaces the marker; it never back-dates.
        return { ...state, openTurnStart: event.time }
      case 'turn/end': {
        if (state.openTurnStart === null) return state
        return {
          ...state,
          activeMs: state.activeMs + Math.max(0, event.time - state.openTurnStart),
          turns: state.turns + 1,
          openTurnStart: null,
        }
      }
      default:
        // Unrelated events must return the SAME reference (registry contract).
        return state
    }
  },
  wire: {
    viewSchema: ponytailStatsViewSchema,
    view: (state) => ({
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cacheReadTokens: state.cacheReadTokens,
      cacheWriteTokens: state.cacheWriteTokens,
      usageReports: state.usageReports,
      turns: state.turns,
      activeMs: state.activeMs,
      openTurnStart: state.openTurnStart,
    }),
  },
}

// --- Effective-state route (read-only) -------------------------------------

const MAX_RPC_ID_LENGTH = 200
const MAX_SESSION_ID_LENGTH = 256

/**
 * Validate one POST body for `/api/ponytail/state` against the Connection RPC
 * envelope. Pure and exported so tests can drive it directly; index.js calls it
 * from inside the real route closure, so tests never bypass the production path.
 * @returns `{ ok: true, body }` or `{ ok: false, message }`.
 */
export function parsePonytailStateRequest(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'body must be a client-request object' }
  }
  if (body.type !== 'client-request') return { ok: false, message: 'type must be "client-request"' }
  const rpcId = body.rpcId
  if (typeof rpcId !== 'string' || rpcId.length === 0 || rpcId.length > MAX_RPC_ID_LENGTH) {
    return { ok: false, message: `rpcId must be a nonempty string of at most ${MAX_RPC_ID_LENGTH} characters` }
  }
  if (body.method !== 'ponytail/state') return { ok: false, message: 'method must be "ponytail/state"' }
  const payload = body.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, message: 'payload must be an object' }
  }
  const sessionId = payload.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_LENGTH) {
    return { ok: false, message: `payload.sessionId must be a nonempty string of at most ${MAX_SESSION_ID_LENGTH} characters` }
  }
  return { ok: true, body: { rpcId, sessionId } }
}

/** The fixed shape of the route's request, for callers that want to build one. */
export function ponytailStateRequest(rpcId, sessionId) {
  return { type: 'client-request', rpcId, method: 'ponytail/state', payload: { sessionId } }
}

// --- Last recorded test command (live process only, in-memory) --------------

/** Tools whose canonical foreground result carries the exit-code DTO. */
const TEST_TOOLS = new Set(['bash', 'pwsh', 'exec_command'])

/**
 * Anchored runner patterns. A match must be followed by whitespace or the end of
 * the command; any standard argument tail after that is allowed. Labels are fixed
 * strings — the raw command and its arguments (which may carry secrets) are never
 * stored, only the matched runner label.
 */
const TEST_RUNNERS = [
  { runner: 'npm test', pattern: /^npm(?:\s+run)?\s+test(?=\s|$)/ },
  { runner: 'pnpm test', pattern: /^pnpm(?:\s+run)?\s+test(?=\s|$)/ },
  { runner: 'yarn test', pattern: /^yarn\s+test(?=\s|$)/ },
  { runner: 'bun test', pattern: /^bun\s+test(?=\s|$)/ },
  { runner: 'node --test', pattern: /^node\s+--test(?=\s|$)/ },
  { runner: 'dotnet test', pattern: /^dotnet\s+test(?=\s|$)/ },
  { runner: 'go test', pattern: /^go\s+test(?=\s|$)/ },
  { runner: 'cargo test', pattern: /^cargo\s+test(?=\s|$)/ },
  { runner: 'pytest', pattern: /^pytest(?=\s|$)/ },
  { runner: 'python -m pytest', pattern: /^python[3]?\s+-m\s+pytest(?=\s|$)/ },
  { runner: 'npx jest', pattern: /^npx\s+jest(?=\s|$)/ },
  { runner: 'npx vitest', pattern: /^npx\s+vitest(?=\s|$)/ },
  { runner: 'jest', pattern: /^jest(?=\s|$)/ },
  { runner: 'vitest', pattern: /^vitest(?=\s|$)/ },
]

/** Shell operators / multiline commands are out of scope for this band. */
const SHELL_OPERATORS = /[;&|`]/

/**
 * Pure helper: turn one canonical `tools/result` DTO into the last-test record, or
 * null when it is not a simple foreground test command. Contract verified against
 * dsh-tools lib/index.js (notifyResult lines ~3503-3517): `ctx.on('tools/result',
 * (exec, result) => …)` with exec = { agent, name, arguments, … } and the canonical
 * result { isError, value, … }; the bash foreground value is
 * { kind: 'foreground', exitCode: number|null, timedOut, aborted, signal, … }.
 * Prose/stdout is never parsed — an exit code is
 * evidence for that command only, and no test counts or all-pass claims are made.
 * shortcut: only simple foreground test commands; add background job tracking when its result contract is verified.
 */
export function recordedTestResult(exec, result) {
  if (!exec || typeof exec !== 'object') return null
  if (!TEST_TOOLS.has(exec.name)) return null
  const args = exec.arguments
  if (!args || typeof args !== 'object') return null
  const command = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : ''
  const trimmed = command.trim()
  // Multiline and operator-composed commands are rejected outright: a simple
  // foreground command is the only shape whose exit code maps to one runner.
  if (!trimmed || /[\r\n]/.test(trimmed) || SHELL_OPERATORS.test(trimmed)) return null
  let runner = null
  for (const candidate of TEST_RUNNERS) {
    if (candidate.pattern.test(trimmed)) {
      runner = candidate.runner
      break
    }
  }
  if (runner === null) return null
  const value = result && typeof result === 'object' ? result.value : undefined
  if (result?.isError || !value || typeof value !== 'object' || value.kind !== 'foreground') return null
  const interrupted = value.timedOut === true
    || value.aborted === true
    || (value.signal !== null && value.signal !== undefined)
    || value.exitCode === null
  if (interrupted) return { runner, exitCode: null, status: 'interrupted' }
  if (typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode) && value.exitCode >= 0) {
    return { runner, exitCode: value.exitCode, status: 'exit' }
  }
  return null
}
