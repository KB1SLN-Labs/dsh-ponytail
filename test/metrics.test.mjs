// Metrics tests for @kb1slnlabs/dsh-ponytail: the ponytailStats projection fold
// and the read-only /api/ponytail/state route. No model calls, no network, no
// live profile — DSH_ROOT only supplies the host service implementations and the
// zod instance the host's own projection/stats packages depend on.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.join(here, '..')

function locateDshModules() {
  if (!process.env.DSH_ROOT) throw new Error('DSH_ROOT must point at the @deepseek-ai/dsh package directory (e.g. work/rc3-runtime/dsh); no global-CLI fallback')
  const hostModules = path.join(process.env.DSH_ROOT, 'node_modules')
  if (!fs.existsSync(hostModules)) throw new Error(`DSH_ROOT has no node_modules: ${hostModules}`)
  return hostModules
}

const hostModules = locateDshModules()
// Same isolated peer junction the adapter suite uses (removed on exit), so bare
// specifiers — including zod, which only the HOST tree carries — resolve.
const link = path.join(pkgDir, 'node_modules')
let createdLink = false
if (!fs.existsSync(link)) {
  fs.symlinkSync(hostModules, link, 'junction')
  createdLink = true
} else if (!fs.lstatSync(link).isSymbolicLink()) {
  throw new Error(`${link} exists and is not the test junction — refusing to touch it`)
}
process.on('exit', () => { if (createdLink) { try { fs.unlinkSync(link) } catch {} } })

const metrics = await import(pathToFileURL(path.join(pkgDir, 'metrics.js')).href)
const plugin = await import(pathToFileURL(path.join(pkgDir, 'index.js')).href)
const zodHost = await import(pathToFileURL(path.join(hostModules, 'zod', 'index.js')).href)
const { Context } = await import(pathToFileURL(path.join(hostModules, '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)

const definition = metrics.ponytailStatsProjectionDefinition

// Drive the fold exactly like the host registry does: one pass per event, in
// seq order, carrying the state forward. Each actual event is seen once.
function fold(events, inheritedEventCount = 0) {
  let state = definition.init({ id: 's' }, inheritedEventCount)
  for (const event of events) state = definition.apply(state, event)
  return state
}

const usageEvent = (seq, time, usage, type = 'assistant/message') => ({
  seq, time, type, data: { turn: 1, step: 1, ...(usage === undefined ? {} : { usage }) },
})

test('definition shape matches the host session-stats unit', () => {
  assert.equal(definition.key, 'ponytailStats')
  assert.equal(definition.stateVersion, 1)
  assert.ok(definition.stateSchema && typeof definition.stateSchema.safeParse === 'function')
  assert.equal(typeof definition.init, 'function')
  assert.equal(typeof definition.apply, 'function')
  assert.ok(definition.wire.viewSchema && typeof definition.wire.view === 'function')
  const init = definition.init({ id: 's' }, 0)
  assert.deepEqual(Object.keys(init).sort(), ['activeMs', 'cacheReadTokens', 'cacheWriteTokens', 'inheritedEventCount', 'inputTokens', 'openTurnStart', 'outputTokens', 'turns', 'usageReports'])
  assert.equal(init.openTurnStart, null)
  // init is pure and defaults the cut to 0 when the host omits it.
  assert.equal(definition.init({ id: 's' }).inheritedEventCount, 0)
})

test('zod comes from the host peer tree and validates state + view', () => {
  // zod is a host-declared optional peer; metrics.js imports the bare specifier.
  const z = zodHost.z ?? (zodHost.default && zodHost.default.z)
  assert.ok(z, 'host node_modules carries zod')
  const init = definition.init({ id: 's' }, 3)
  assert.ok(definition.stateSchema.safeParse(init).success, 'init state satisfies stateSchema')
  assert.ok(definition.wire.viewSchema.safeParse(definition.wire.view(init)).success, 'view satisfies viewSchema')
  // The view is only public totals + openTurnStart + usageReports — the internal
  // inheritedEventCount cut never rides the wire.
  assert.deepEqual(Object.keys(definition.wire.view(init)).sort(), ['activeMs', 'cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'openTurnStart', 'outputTokens', 'turns', 'usageReports'])
  assert.equal(definition.stateSchema.safeParse({ ...init, moneySavedUsd: 1 }).success, false, 'no monetary field is even representable')
})

test('successful AND failed attempt usage each count once (host-sequenced fold)', () => {
  const events = [
    usageEvent(1, 100, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 50 }),
    // A failed attempt that still paid for its tokens — it counts too, and its
    // usage lives ONLY in the embedded stream (see the next test for the shape).
    usageEvent(2, 300, { inputTokens: 900, outputTokens: 100 }, 'assistant/attempt'),
  ]
  const state = fold(events)
  assert.equal(state.usageReports, 2)
  assert.equal(state.inputTokens, 1900)
  assert.equal(state.outputTokens, 300)
  // Cache fields stay SEPARATE subsets — never added into the input total.
  assert.equal(state.cacheReadTokens, 400)
  assert.equal(state.cacheWriteTokens, 50)
})

test('usage comes from ONE source per event: direct, or the stream for a failed attempt', () => {
  // Real failed-attempt shape (dsh-agent-loop lines 1090-1170): data carries ONLY
  // `stream` — no invented data.usage. Usage lives in the last embedded raw chunk.
  const failedAttempt = {
    seq: 1, time: 100, type: 'assistant/attempt',
    data: {
      turn: 1, step: 1,
      stream: [
        { type: 'chunk', time: 110, chunk: { type: 'text-delta', text: 'partial' } },
        { type: 'chunk', time: 120, chunk: { type: 'usage', usage: { inputTokens: 900, outputTokens: 100 } } },
      ],
    },
  }
  // A settled message carries direct usage AND the same stream — counted ONCE.
  const settled = {
    seq: 2, time: 300, type: 'assistant/message',
    data: {
      turn: 1, step: 2,
      usage: { inputTokens: 1000, outputTokens: 200 },
      stream: [
        { type: 'chunk', time: 310, chunk: { type: 'usage', usage: { inputTokens: 1000, outputTokens: 200 } } },
      ],
    },
  }
  // Usage absent in both places stays unknown (no invented state).
  const noUsage = { seq: 3, time: 400, type: 'assistant/attempt', data: { turn: 1, step: 3, stream: [{ type: 'chunk', time: 410, chunk: { type: 'text-delta', text: 'x' } }] } }
  const state = fold([failedAttempt, settled, noUsage])
  assert.equal(state.usageReports, 2)
  assert.equal(state.inputTokens, 1900, 'stream-only usage + direct usage, each exactly once')
  assert.equal(state.outputTokens, 300)
})

test('fractional token counts are ignored; integer wire values stay valid', () => {
  const state = fold([
    usageEvent(1, 100, { inputTokens: 10.5, outputTokens: 20, cacheReadTokens: 1.25, cacheWriteTokens: Number.MAX_SAFE_INTEGER + 1 }),
    usageEvent(2, 200, { inputTokens: 7, outputTokens: 3 }),
  ])
  assert.equal(state.inputTokens, 7, 'fractional inputTokens ignored; integer accepted')
  assert.equal(state.outputTokens, 23)
  assert.equal(state.cacheReadTokens, 0, 'fractional cache value ignored')
  assert.equal(state.cacheWriteTokens, 0, 'beyond-safe-integer value ignored')
  assert.equal(state.usageReports, 2)
  // The counters are int() schemas: integers validate, fractions never do.
  const view = definition.wire.view(state)
  assert.ok(definition.wire.viewSchema.safeParse(view).success)
  assert.equal(definition.wire.viewSchema.safeParse({ ...view, inputTokens: 1.5 }).success, false)
})

test('missing / NaN / Infinity / negative usage is ignored field by field', () => {
  const state = fold([
    usageEvent(1, 100, undefined),                                        // no usage at all
    usageEvent(2, 200, {}),                                               // empty usage
    usageEvent(3, 300, { inputTokens: Number.NaN, outputTokens: -5 }),    // invalid both sides
    usageEvent(4, 400, { inputTokens: Number.POSITIVE_INFINITY, cacheReadTokens: '42' }),
    usageEvent(5, 500, { inputTokens: 10, outputTokens: Number.NaN, cacheWriteTokens: -1 }), // partial
  ])
  assert.equal(state.inputTokens, 10)
  assert.equal(state.outputTokens, 0)
  assert.equal(state.cacheReadTokens, 0)
  assert.equal(state.cacheWriteTokens, 0)
  // usageReports increments only when at least one of input/output is present+valid.
  assert.equal(state.usageReports, 1)
})

test('paired turn/start + turn/end accumulate activeMs and turns; delta clamps >= 0', () => {
  const state = fold([
    { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time: 2500, type: 'turn/end', data: { turn: 1, reason: 'done' } },
    // Backwards timestamps must clamp to 0, never go negative.
    { seq: 3, time: 3000, type: 'turn/start', data: { turn: 2 } },
    { seq: 4, time: 2000, type: 'turn/end', data: { turn: 2, reason: 'done' } },
  ])
  assert.equal(state.turns, 2)
  assert.equal(state.activeMs, 1500)
  assert.equal(state.openTurnStart, null)
})

test('malformed / unpaired turn events: orphan end invents no time; orphan start stays open', () => {
  const orphanEnd = fold([{ seq: 1, time: 5000, type: 'turn/end', data: { turn: 7, reason: 'done' } }])
  assert.equal(orphanEnd.activeMs, 0)
  assert.equal(orphanEnd.turns, 0)
  const open = fold([
    { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time: 1800, type: 'turn/start', data: { turn: 2 } }, // missing end for turn 1
  ])
  assert.equal(open.turns, 0)
  assert.equal(open.activeMs, 0)
  assert.equal(open.openTurnStart, 1800, 'the open turn marker is the public signal; no time is invented')
  const closed = definition.apply(open, { seq: 3, time: 2300, type: 'turn/end', data: { turn: 2, reason: 'done' } })
  assert.equal(closed.activeMs, 500)
  assert.equal(closed.turns, 1)
})

test('fork seed excluded: events below inheritedEventCount are never billed twice', () => {
  const seed = [
    usageEvent(1, 100, { inputTokens: 5000, outputTokens: 900 }),
    { seq: 2, time: 50, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, time: 900, type: 'turn/end', data: { turn: 1, reason: 'done' } },
  ]
  const own = [
    usageEvent(4, 1000, { inputTokens: 100, outputTokens: 20 }),
    { seq: 5, time: 1000, type: 'turn/start', data: { turn: 2 } },
    { seq: 6, time: 1500, type: 'turn/end', data: { turn: 2, reason: 'done' } },
  ]
  const state = fold([...seed, ...own], 3)
  assert.equal(state.inheritedEventCount, 3)
  assert.equal(state.inputTokens, 100)
  assert.equal(state.outputTokens, 20)
  assert.equal(state.usageReports, 1)
  assert.equal(state.turns, 1)
  assert.equal(state.activeMs, 500)
  // apply returns the SAME reference for a skipped event (registry contract).
  const base = definition.init({ id: 's' }, 3)
  assert.equal(definition.apply(base, seed[0]), base)
})

test('view schema rejects junk and stays strict about what it publishes', () => {
  const view = definition.wire.view(fold([usageEvent(1, 100, { inputTokens: 1, outputTokens: 1 })]))
  assert.ok(definition.wire.viewSchema.safeParse(view).success)
  assert.equal(definition.wire.viewSchema.safeParse({ ...view, estimatedSavings: 2 }).success, false)
  assert.equal(definition.wire.viewSchema.safeParse({ ...view, inputTokens: -1 }).success, false)
})

// --- Route: envelope validation + the real apply-closure handler -------------

test('route validator rejects malformed RPC envelopes with a fixed message', () => {
  const bad = [
    undefined, null, 'nope', [], 42,
    { type: 'server-response', rpcId: 'r1', method: 'ponytail/state', payload: { sessionId: 's' } },
    { type: 'client-request', method: 'ponytail/state', payload: { sessionId: 's' } },           // missing rpcId
    { type: 'client-request', rpcId: '', method: 'ponytail/state', payload: { sessionId: 's' } }, // empty rpcId
    { type: 'client-request', rpcId: 'x'.repeat(201), method: 'ponytail/state', payload: { sessionId: 's' } },
    { type: 'client-request', rpcId: 'r1', method: 'ponytail/other', payload: { sessionId: 's' } },
    { type: 'client-request', rpcId: 'r1', method: 'ponytail/state', payload: {} },               // missing sessionId
    { type: 'client-request', rpcId: 'r1', method: 'ponytail/state', payload: { sessionId: '' } },
    { type: 'client-request', rpcId: 'r1', method: 'ponytail/state', payload: { sessionId: 'y'.repeat(257) } },
  ]
  for (const body of bad) {
    const parsed = metrics.parsePonytailStateRequest(body)
    assert.equal(parsed.ok, false, `rejected: ${JSON.stringify(body) ?? String(body)}`)
    assert.equal(typeof parsed.message, 'string')
  }
  // Arbitrarily long/garbage input is never reflected in the error message.
  const weird = { type: 'client-request', rpcId: 'r1', method: 'SECRET-ECHO-MARKER'.repeat(50), payload: { sessionId: 's' } }
  const parsed = metrics.parsePonytailStateRequest(weird)
  assert.equal(parsed.ok, false)
  assert.ok(!parsed.message.includes('SECRET-ECHO-MARKER'), 'error message does not echo arbitrary input')
  const good = metrics.parsePonytailStateRequest(metrics.ponytailStateRequest('r1', 's'))
  assert.deepEqual(good, { ok: true, body: { rpcId: 'r1', sessionId: 's' } })
})

test('route inside apply(): reads the REAL ModeStore + volatile config; no writes', async () => {
  // The REAL HostConnectionService — no handmade fake. Its registerFetchRoute runs
  // the registration on the actual reader child's fiber and returns an already-owned
  // Cordis effect disposer, so dispose genuinely removes the route (the earlier stub
  // registered on the ROOT ctx.effect instead of the actual reader child, which is
  // why the dispose assertion failed). Constructor verified by the parent:
  // new HostConnectionService(ctx, ['localhost'], {}) works; browserAuth {} is unused
  // because the test drives the carrier directly.
  const ctx = new Context()
  // apply() has REQUIRED injects (systemPrompt, skills) — a standalone ctx needs
  // the real services, exactly like the adapter fixture. Do not weaken `inject`.
  const SystemPrompt = (await import(pathToFileURL(path.join(hostModules, '@deepseek-ai', 'dsh-system-prompt', 'lib', 'index.js')).href)).default
  const SkillRegistry = (await import(pathToFileURL(path.join(hostModules, '@deepseek-ai', 'dsh-skill', 'lib', 'index.js')).href)).default
  new SystemPrompt(ctx, {})
  new SkillRegistry(ctx)
  const { HostConnectionService } = await import(pathToFileURL(path.join(hostModules, '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js')).href)
  const host = new HostConnectionService(ctx, ['localhost'], {})
  const carrier = host.createSharedFetchHandler('/api')
  const owner = { principal: { kind: 'owner' } }
  const fiber = await ctx.plugin(plugin, { defaultMode: 'full', showBand: false, disabledSkills: ['ponytail-help'] })
  await new Promise(resolve => setImmediate(resolve))

  const call = async (body) => {
    const response = await carrier.fetch(new Request('http://host/api/ponytail/state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }), owner)
    return { response, json: await response.json() }
  }

  // Envelope errors: 400 + fixed error, never an echo of the payload.
  for (const bad of [{ type: 'client-request', rpcId: 'r1', method: 'wrong/method', payload: { sessionId: 's' } }, {}, null]) {
    const { response, json } = await call(bad)
    assert.equal(response.status, 400)
    assert.equal(typeof json.error, 'string')
    assert.equal(json.type, undefined)
  }
  const notJson = await carrier.fetch(new Request('http://host/api/ponytail/state', { method: 'POST', body: '{oops' }), owner)
  assert.equal(notJson.status, 400)

  // Profile default (no session override yet).
  const first = await call(metrics.ponytailStateRequest('rpc-1', 'sess-a'))
  assert.equal(first.response.status, 200)
  assert.equal(first.response.headers.get('cache-control'), 'no-store')
  assert.deepEqual(first.json, {
    type: 'server-response',
    rpcId: 'rpc-1',
    result: {
      ok: true,
      value: {
        mode: 'full',
        defaultMode: 'full',
        source: 'Profile default',
        showBand: false,
        expandedBand: false,
        disabledSkills: ['ponytail-help'],
        lastTest: null,
      },
    },
  })

  // The ACTUAL tools/result event with a real host DTO shape (dsh-tools notifyResult
  // contract) lands the last-test record for the RIGHT session only.
  const testAgent = { id: 'agent-t', session: { id: 'sess-a' } }
  ctx.emit('tools/result',
    { name: 'bash', callId: 'c-1', agent: testAgent, arguments: { command: 'node --test "test/*.test.mjs"' } },
    { isError: false, value: { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false } })
  const withTest = await call(metrics.ponytailStateRequest('rpc-1b', 'sess-a'))
  assert.deepEqual(withTest.json.result.value.lastTest, { runner: 'node --test', exitCode: 0, status: 'exit' },
    'route exposes the last test for the matching session only')
  const otherSession = await call(metrics.ponytailStateRequest('rpc-1c', 'sess-c'))
  assert.equal(otherSession.json.result.value.lastTest, null, 'another session never sees the record')

  // agent/disposed clears it alongside the mode override.
  ctx.emit('agent/disposed', { agent: testAgent })
  const afterDispose = await call(metrics.ponytailStateRequest('rpc-1d', 'sess-a'))
  assert.equal(afterDispose.json.result.value.lastTest, null, 'agent/disposed clears the last-test record')

  // Drive the ACTUAL /ponytail command handler through the real registry so the
  // route's "Session override" view comes from the same ModeStore the command writes.
  const CommandRuntime = (await import(pathToFileURL(path.join(hostModules, '@deepseek-ai', 'dsh-commands', 'lib', 'index.js')).href)).default
  new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  const agent = { id: 'agent-a', session: { id: 'sess-b', header: { cwd: process.cwd() }, append: () => Promise.resolve({ seq: 1 }) }, inject: () => {}, followup: () => {} }
  const executed = await ctx.get('commands').execute(agent, '/ponytail ultra', [], new AbortController().signal)
  assert.equal(executed.result.kind, 'success')
  const second = await call(metrics.ponytailStateRequest('rpc-2', 'sess-b'))
  assert.deepEqual(second.json.result.value, {
    mode: 'ultra',
    defaultMode: 'full',
    source: 'Session override',
    showBand: false,
    expandedBand: false,
    disabledSkills: ['ponytail-help'],
    lastTest: null,
  }, 'route reports the CURRENT session override from the same ModeStore /ponytail writes')

  // Read-only: nothing was appended to any session and no config write happened.
  assert.equal(agent.session.appendCalls ?? undefined, undefined)

  // Non-owner peers are rejected by the host's own route authorization (any
  // non-owner kind fails the owner check) — the route metadata is enforced by the
  // actual register path, never introspected here.
  const remotePeer = { principal: { kind: 'remote' } }
  const forbidden = await carrier.fetch(new Request('http://host/api/ponytail/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metrics.ponytailStateRequest('rpc-3', 'sess-a')),
  }), remotePeer)
  assert.equal(forbidden.status, 403, 'non-owner peer cannot read the route')

  await fiber.dispose()
  // The host-owned effect disposer (owned by the actual reader child's fiber) ran
  // with the plugin: a valid POST to the same path is now 404, proving the real
  // scope effect removed the route.
  const gone = await carrier.fetch(new Request('http://host/api/ponytail/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(metrics.ponytailStateRequest('rpc-4', 'sess-a')),
  }), owner)
  assert.equal(gone.status, 404, 'dispose removed the route')
  // Let the host finish cleaning up its native peers after the plugin fiber is gone.
  await ctx.fiber.dispose()
})

// --- recordedTestResult: pure helper over ACTUAL DTO shapes, never prose -------

const foregroundValue = (overrides = {}) => ({
  kind: 'foreground', cwd: '/w', exitCode: 0, signal: null, timedOut: false, aborted: false,
  stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false }, ...overrides,
})
const execFor = (name, command) => ({ name, callId: 'c', agent: { session: { id: 's' } }, arguments: { command } })

test('recordedTestResult records simple foreground test commands with an exit code', () => {
  const cases = [
    ['npm test', 'npm test'], ['npm run test -- --unit', 'npm test'], ['pnpm test', 'pnpm test'],
    ['yarn test --watch=false', 'yarn test'], ['bun test', 'bun test'],
    ['node --test "test/*.test.mjs"', 'node --test'], ['dotnet test -c Release', 'dotnet test'],
    ['go test ./...', 'go test'], ['cargo test', 'cargo test'], ['pytest -q', 'pytest'],
    ['python3 -m pytest tests/', 'python -m pytest'], ['npx vitest run', 'npx vitest'],
    ['jest --coverage', 'jest'], ['vitest', 'vitest'],
  ]
  for (const [command, runner] of cases) {
    const record = metrics.recordedTestResult(execFor('bash', command), { isError: false, value: foregroundValue({ exitCode: 0 }) })
    assert.deepEqual(record, { runner, exitCode: 0, status: 'exit' }, `recorded: ${command}`)
  }
  const nonzero = metrics.recordedTestResult(execFor('pwsh', 'npm test'), { isError: false, value: foregroundValue({ exitCode: 1 }) })
  assert.deepEqual(nonzero, { runner: 'npm test', exitCode: 1, status: 'exit' }, 'a failing exit is recorded as evidence, not hidden')
})

test('recordedTestResult marks timeout / abort / signal / null exit as interrupted', () => {
  const interrupted = [
    { timedOut: true, exitCode: null },
    { aborted: true, exitCode: null },
    { signal: 'SIGTERM', exitCode: null },
    { exitCode: null },
  ]
  for (const overrides of interrupted) {
    const record = metrics.recordedTestResult(execFor('bash', 'npm test'), { isError: false, value: foregroundValue(overrides) })
    assert.deepEqual(record, { runner: 'npm test', exitCode: null, status: 'interrupted' }, `interrupted: ${JSON.stringify(overrides)}`)
  }
})

test('recordedTestResult rejects everything that is not a simple foreground test command', () => {
  const ok = { isError: false, value: foregroundValue() }
  const rejected = [
    // stdout spoofing "pass" with no DTO at all.
    [{ name: 'bash', arguments: { command: 'npm test' } }, { isError: false, content: [{ type: 'text', text: '36 pass 0 fail' }] }],
    // error result even with a foreground value.
    [execFor('bash', 'npm test'), { isError: true, error: { message: 'boom' } }],
    // wrong DTO shape / unknown kind.
    [execFor('bash', 'npm test'), { isError: false, value: { kind: 'promoted', jobId: 'j1' } }],
    [execFor('bash', 'npm test'), { isError: false, value: null }],
    [execFor('bash', 'npm test'), undefined],
    // multiline and shell operators are out of scope.
    [execFor('bash', 'npm test && echo done'), ok],
    [execFor('bash', 'npm test; npm run lint'), ok],
    [execFor('bash', 'echo x | npm test'), ok],
    [execFor('bash', 'npm test &'), ok],
    [execFor('bash', 'set -e\nnpm test'), ok],
    // not a test runner, or a lookalike that must not match.
    [execFor('bash', 'npm install'), ok],
    [execFor('bash', 'npm testing-the-build'), ok],
    [execFor('bash', 'npx eslint .'), ok],
    [execFor('read', 'file.txt'), ok],
    [execFor('bash', ''), ok],
    [execFor('bash', undefined), ok],
    [{ name: 'bash', arguments: null }, ok],
    [null, ok],
  ]
  for (const [exec, result] of rejected) {
    assert.equal(metrics.recordedTestResult(exec, result), null, `rejected: ${JSON.stringify(exec?.arguments ?? exec)}`)
  }
})

test('recordedTestResult keeps only the runner label — never the raw command or arguments', () => {
  const record = metrics.recordedTestResult(
    execFor('bash', 'npm test -- --token=SUPERSECRET-ARG'),
    { isError: false, value: foregroundValue({ exitCode: 0 }) })
  assert.deepEqual(record, { runner: 'npm test', exitCode: 0, status: 'exit' })
  const serialized = JSON.stringify(record)
  assert.ok(!serialized.includes('SUPERSECRET'), 'the record retains no secret argument material')
})
