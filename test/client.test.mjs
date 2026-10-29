// Pure loadHistory tests for @kb1slnlabs/dsh-ponytail. The ACTUAL published client.js
// wrapper is evaluated in a node:vm context with a fake window.__ModuleLoader__.load
// capture; the factory's require('react') gets an explicit stub (loadHistory itself
// touches no hooks, so nothing renders). No DOM, no live profile, no model calls.
// The tests drive production loadHistory through fake remote.session contracts — they
// never re-implement its algorithm.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

function loadClientModule() {
  const source = fs.readFileSync(clientPath, 'utf8')
  let captured = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (descriptor) => {
          if (!descriptor || descriptor.id !== '@kb1slnlabs/dsh-ponytail' || typeof descriptor.factory !== 'function') {
            throw new Error('client.js did not register the expected module descriptor')
          }
          captured = descriptor
        },
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: clientPath })
  if (!captured) throw new Error('window.__ModuleLoader__.load was never called by client.js')
  const exports = captured.factory((specifier) => {
    if (specifier === 'react') return reactStub()
    throw new Error(`unexpected require('${specifier}') from the client factory`)
  })
  return exports
}

// Minimal React surface: loadHistory calls no hooks, so anything else is a test bug.
function reactStub() {
  const fail = (name) => () => { throw new Error(`React.${name} must not be called by loadHistory`) }
  return { createElement: fail('createElement'), useState: fail('useState'), useCallback: fail('useCallback') }
}

const client = loadClientModule()
assert.equal(typeof client.loadHistory, 'function', 'client.js exports loadHistory')

// ---------- fake remote.session (host-shaped results only) ----------

const okValue = (value) => ({ ok: true, value })
const okResult = (stats) => okValue({ kind: 'sequenced', values: { ponytailStats: stats } })
const failResult = (message) => ({ ok: false, error: { message } })

function stats(overrides = {}) {
  return {
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, cacheWriteTokens: 5,
    usageReports: 3, turns: 2, activeMs: 5000, openTurnStart: null, ...overrides,
  }
}

function makeRemote(items, projections) {
  const calls = { list: [], projectionSessionIds: [], projectionSignals: [] }
  return {
    calls,
    session: {
      async list(query, signal) {
        calls.list.push({ query, signal })
        return typeof items === 'function' ? items(signal) : items
      },
      async projections(query, signal) {
        calls.projectionSessionIds.push(query.sessionId)
        calls.projectionSignals.push(signal)
        return projections.get(query.sessionId)
      },
    },
  }
}

// A fake whose projection reads hang until the test resolves them — this is what lets a
// late, already-aborted read be observed trying to land after a newer one.
function makeGatedRemote(items) {
  const calls = { list: [], projections: [] }
  return {
    calls,
    session: {
      async list(query, signal) {
        calls.list.push({ query, signal })
        return items
      },
      projections(query, signal) {
        return new Promise((resolve, reject) => {
          calls.projections.push({ sessionId: query.sessionId, signal, resolve, reject })
        })
      },
    },
  }
}

const row = (sessionId, extra = {}) => ({ sessionId, title: `session ${sessionId}`, cwd: '/w', project: 'p', updatedAt: Date.parse('2026-10-01T12:00:00Z'), ...extra })

// client.js runs in a node:vm realm, so its objects have vm-realm prototypes;
// assert/strict.deepEqual compares them against Node-realm literals by prototype and
// fails on identical content. Normalize ONLY the VM-produced actual through JSON for
// whole-object deep comparisons — the values being asserted stay strictly checked.
const plain = (value) => JSON.parse(JSON.stringify(value))

// ---------- (1) list failure rejects ----------

test('loadHistory rejects when the session list call fails', async () => {
  const remote = makeRemote(failResult('the session store is unavailable'), new Map())
  await assert.rejects(() => client.loadHistory(remote, undefined), /the session store is unavailable/)
})

test('loadHistory rejects a malformed remote instead of inventing history', async () => {
  await assert.rejects(() => client.loadHistory({}, undefined), /loadHistory needs remote\.session\.list/)
})

test('an ok list whose items are missing or not an array throws a readable error, never fake-empty history', async () => {
  for (const value of [undefined, null, {}, { items: 'nope' }, { items: {} }]) {
    const remote = makeRemote(okValue(value), new Map())
    await assert.rejects(() => client.loadHistory(remote, undefined), /not recognised: expected a value with an items array/)
  }
})

// ---------- (2) cold sessions: bounded fetch, full coverage, exact counters ----------

test('cold sessions are fetched without any commands or Agent APIs, max 4 in flight, all rows covered', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'g2']
  const items = okValue({ items: ids.map((id) => row(id)) })
  const projections = new Map(ids.map((id) => [id, okResult(stats({ inputTokens: ids.indexOf(id) * 10 }))]))
  const remote = makeRemote(items, projections)

  let active = 0
  let maxActive = 0
  const originalProjections = remote.session.projections
  remote.session.projections = async (query, signal) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      await new Promise((resolve, reject) => {
        setTimeout(resolve, 5 + ids.indexOf(query.sessionId))
        if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true })
      })
      return originalProjections(query, signal)
    } finally {
      active -= 1
    }
  }

  const progress = []
  const controller = new AbortController()
  const result = await client.loadHistory(remote, controller.signal, { onProgress: (p) => progress.push(p) })

  // No Agent surface and no command surface exists in this fake at all — if the code
  // reached for one it would have thrown. Assert the call shape explicitly.
  assert.equal(remote.calls.list.length, 1, 'exactly one list call')
  assert.deepEqual(plain(remote.calls.list[0].query), {}, 'list called with an empty query')
  assert.deepEqual([...new Set(remote.calls.projectionSessionIds)].sort(), [...ids].sort(), 'every row got exactly one projection read')
  assert.equal(remote.calls.projectionSessionIds.length, ids.length)
  assert.ok(maxActive <= 4, `at most 4 concurrent reads (observed ${maxActive})`)
  assert.ok(maxActive > 1, 'reads genuinely run concurrently')

  // Actual return shape: { rows, total, available, failed, catalogTotal, projects }.
  assert.deepEqual(Object.keys(result).sort(), ['available', 'catalogTotal', 'failed', 'projects', 'rows', 'total'])
  assert.equal(result.total, ids.length)
  assert.equal(result.available, ids.length)
  assert.equal(result.failed, 0)
  assert.equal(result.catalogTotal, ids.length, 'no filter means the catalog is the whole list')
  assert.deepEqual(plain(result.projects), ['p'], 'projects come from all mapped metadata')
  assert.equal(result.rows.length, ids.length)
  for (const [index, item] of result.rows.entries()) {
    assert.equal(item.sessionId, ids[index])
    assert.equal(item.status, 'available')
    assert.equal(item.stats.usageReports, 3)
    assert.equal(item.stats.inputTokens, index * 10)
    assert.equal(item.dateKey, '2026-10-01')
    assert.equal(item.updatedAtMs, Date.parse('2026-10-01T12:00:00Z'))
    assert.equal(item.statusMessage, '')
  }

  // Every projection read carries the caller's abort signal.
  assert.ok(remote.calls.projectionSignals.every((signal) => signal === controller.signal), 'abort signal passed to every read')

  // Reported counters advance monotonically and land on the final totals.
  assert.equal(progress.length, ids.length + 1, 'one report after the list plus one per resolved row')
  for (const p of progress) {
    assert.deepEqual(Object.keys(p).sort(), ['available', 'catalogTotal', 'failed', 'projectCount', 'total'])
    assert.equal(p.total, ids.length)
  }
  assert.deepEqual(plain(progress[0]), { total: ids.length, available: 0, failed: 0, catalogTotal: ids.length, projectCount: 1 })
  let prevAvailable = 0
  for (const p of progress) {
    assert.ok(p.available >= prevAvailable, 'available never regresses')
    prevAvailable = p.available
  }
  assert.deepEqual(plain(progress[progress.length - 1]), { total: ids.length, available: ids.length, failed: 0, catalogTotal: ids.length, projectCount: 1 })
})

test('a null list entry surfaces as an identity failure, never a crash or invented usage', async () => {
  const items = okValue({ items: [row('good'), null] })
  const remote = makeRemote(items, new Map([['good', okResult(stats())]]))
  const result = await client.loadHistory(remote, undefined)
  assert.equal(result.rows.length, 2)
  assert.deepEqual(
    plain(result.rows.map((r) => [r.sessionId, r.status])),
    [['good', 'available'], ['', 'no-session-id']],
  )
  assert.equal(result.rows[1].stats, null)
  assert.deepEqual({ total: result.total, available: result.available, failed: result.failed }, { total: 2, available: 1, failed: 1 })
})

test('an aborted walk is never reported as success and emits no progress after the abort', async () => {
  const items = okValue({ items: ['a', 'b', 'c'].map((id) => row(id)) })
  const remote = makeRemote(items, new Map([['a', okResult(stats())], ['b', okResult(stats())], ['c', okResult(stats())]]))
  const controller = new AbortController()
  const progress = []
  // The first projection read aborts the whole walk mid-flight.
  remote.session.projections = async (query, signal) => {
    controller.abort()
    if (signal && signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
    return okResult(stats())
  }
  await assert.rejects(() => client.loadHistory(remote, controller.signal, { onProgress: (p) => progress.push(p) }), (error) => error.name === 'AbortError')
  assert.deepEqual(plain(progress), [{ total: 3, available: 0, failed: 0, catalogTotal: 3, projectCount: 1 }], 'no progress reports after the abort')
})

// ---------- (3) explicit unavailable rows + genuine-zero vs never-measured ----------

test('missing projection / migration-required / read errors are explicitly unavailable and excluded from totals', async () => {
  const items = okValue({ items: [
    row('ok'), row('gone'), row('migrated'), row('broken'), row('nostats'), row('weird'), row(''),
  ] })
  const projections = new Map([
    ['ok', okResult(stats({ inputTokens: 100, outputTokens: 20 }))],
    ['gone', okValue(null)],
    ['migrated', okValue({ kind: 'migration-required' })],
    ['broken', failResult('disk read exploded')],
    ['nostats', okValue({ kind: 'sequenced', values: {} })],
    ['weird', okValue({ kind: 'something-new' })],
  ])
  const remote = makeRemote(items, projections)
  const result = await client.loadHistory(remote, undefined)

  const byId = new Map(result.rows.map((r) => [r.sessionId || '(empty)', r]))
  assert.equal(byId.get('ok').status, 'available')
  assert.equal(byId.get('gone').status, 'no-projection')
  assert.equal(byId.get('migrated').status, 'migration-required')
  assert.equal(byId.get('broken').status, 'error')
  assert.equal(byId.get('broken').statusMessage, 'disk read exploded', 'the row keeps the readable failure reason')
  assert.equal(byId.get('nostats').status, 'no-stats')
  assert.equal(byId.get('weird').status, 'unknown-kind')
  assert.equal(byId.get('(empty)').status, 'no-session-id')
  for (const id of ['gone', 'migrated', 'broken', 'nostats', 'weird', '(empty)']) {
    assert.equal(byId.get(id).stats, null, `${id} contributes no stats`)
  }
  // Counters: only the one usable row is available; every other row is a failure.
  assert.deepEqual(
    { total: result.total, available: result.available, failed: result.failed },
    { total: 7, available: 1, failed: 6 },
  )
})

test('a genuine zero-token report with usageReports >= 1 is measured data; usageReports 0 is not', async () => {
  const items = okValue({ items: [row('zero'), row('unmeasured')] })
  const projections = new Map([
    ['zero', okResult(stats({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usageReports: 1 }))],
    ['unmeasured', okResult(stats({ inputTokens: 0, outputTokens: 0, usageReports: 0 }))],
  ])
  const remote = makeRemote(items, projections)
  const result = await client.loadHistory(remote, undefined)
  const byId = new Map(result.rows.map((r) => [r.sessionId, r]))
  assert.equal(byId.get('zero').status, 'available', 'a reported zero is a real measurement')
  assert.deepEqual(byId.get('zero').stats.inputTokens, 0)
  assert.equal(byId.get('unmeasured').status, 'no-usage', 'zero usage reports was never measured')
  assert.equal(byId.get('unmeasured').stats, null)
  assert.deepEqual({ available: result.available, failed: result.failed }, { available: 1, failed: 1 })
})

// ---------- (5) date/project filters bound the cold reads ----------

const NOW = Date.parse('2026-10-15T12:00:00Z')
const CUTOFF_30D = NOW - 30 * 86400000

function mixedItems() {
  return okValue({ items: [
    row('recent-a', { project: 'alpha', updatedAt: NOW - 2 * 86400000 }),
    // Exactly on the cutoff — the boundary is inclusive.
    row('edge-b', { project: 'beta', updatedAt: CUTOFF_30D }),
    // One millisecond older than the cutoff — must not be read at all.
    row('old-c', { project: 'alpha', updatedAt: CUTOFF_30D - 1 }),
    row('ancient-d', { project: 'gamma', updatedAt: Date.parse('2025-01-01T00:00:00Z') }),
    // Undated rows: excluded by any window, included under All.
    row('undated-e', { project: 'beta', updatedAt: undefined }),
    row('undated-f', { project: 'alpha', updatedAt: null }),
  ] })
}

const projectionMapFor = (ids) => new Map(ids.map((id) => [id, okResult(stats())]))

test('a date window excludes older AND undated rows before any projection read, even when their cache is valid', async () => {
  // old-cached and ancient-cached carry valid cached usage with usageReports > 0 — the
  // old code reported them as available. The filter must drop them at metadata time.
  const items = okValue({ items: [
    row('recent', { updatedAt: NOW - 86400000 }),
    // The edge row carries a valid cache too, so "no read for it" proves the recent-only
    // bound and not merely an absent projection.
    row('edge', { updatedAt: CUTOFF_30D, projections: { values: { ponytailStats: stats({ usageReports: 2 }) } } }),
    row('old-cached', { updatedAt: CUTOFF_30D - 1, projections: { values: { ponytailStats: stats({ usageReports: 4 }) } } }),
    row('ancient-cached', { updatedAt: Date.parse('2025-01-01T00:00:00Z'), projections: { values: { ponytailStats: stats({ usageReports: 9 }) } } }),
    row('undated', { updatedAt: undefined, projections: { values: { ponytailStats: stats({ usageReports: 7 }) } } }),
  ] })
  const remote = makeRemote(items, projectionMapFor(['recent']))
  const result = await client.loadHistory(remote, undefined, { updatedSince: CUTOFF_30D })
  assert.deepEqual(remote.calls.projectionSessionIds, ['recent'], 'only the in-window uncached row is read; the warm edge row needs no read')
  assert.deepEqual(plain(result.rows.map((r) => r.sessionId)), ['recent', 'edge'])
  assert.deepEqual({ total: result.total, catalogTotal: result.catalogTotal }, { total: 2, catalogTotal: 5 })
  assert.equal(result.available, 2)
  assert.equal(result.failed, 0, 'a filtered-out cached row is never counted as a failure')
})

test('the date boundary is inclusive and the progress denominator is the selected count', async () => {
  const remote = makeRemote(mixedItems(), projectionMapFor(['recent-a', 'edge-b']))
  const progress = []
  const result = await client.loadHistory(remote, undefined, { updatedSince: CUTOFF_30D, onProgress: (p) => progress.push(p) })
  assert.deepEqual(plain(result.rows.map((r) => r.sessionId)), ['recent-a', 'edge-b'], 'the exact-cutoff row is included')
  assert.deepEqual(remote.calls.projectionSessionIds, ['recent-a', 'edge-b'])
  assert.equal(result.total, 2)
  assert.equal(result.catalogTotal, 6)
  for (const p of progress) assert.equal(p.total, 2, 'progress total is the selected count')
  assert.equal(progress[0].catalogTotal, 6, 'progress still carries the profile catalog size')
})

test('a project filter reads only matching cwd/project rows and keeps the whole catalog', async () => {
  const remote = makeRemote(mixedItems(), projectionMapFor(['recent-a', 'old-c', 'ancient-d', 'undated-f']))
  const result = await client.loadHistory(remote, undefined, { project: 'alpha' })
  assert.deepEqual(plain(result.rows.map((r) => r.sessionId)), ['recent-a', 'old-c', 'undated-f'], 'ancient-d is a gamma row and never appears under alpha')
  // Reads follow selection order; only alpha rows are read at all.
  assert.deepEqual(remote.calls.projectionSessionIds, ['recent-a', 'old-c', 'undated-f'], 'no beta/gamma row is ever read')
  assert.equal(result.catalogTotal, 6)
  assert.deepEqual(plain(result.projects), ['alpha', 'beta', 'gamma'], 'projects always come from ALL metadata')
})

test('date and project filters combine', async () => {
  const remote = makeRemote(mixedItems(), projectionMapFor(['edge-b']))
  const result = await client.loadHistory(remote, undefined, { updatedSince: CUTOFF_30D, project: 'beta' })
  assert.deepEqual(plain(result.rows.map((r) => r.sessionId)), ['edge-b'])
  assert.deepEqual(remote.calls.projectionSessionIds, ['edge-b'])
  assert.deepEqual({ total: result.total, catalogTotal: result.catalogTotal }, { total: 1, catalogTotal: 6 })
})

test('All reads everything including undated rows; a non-string project falls back to all', async () => {
  const ids = ['recent-a', 'edge-b', 'old-c', 'ancient-d', 'undated-e', 'undated-f']
  const remote = makeRemote(mixedItems(), projectionMapFor(ids))
  const result = await client.loadHistory(remote, undefined, { updatedSince: null, project: 42 })
  assert.equal(result.rows.length, 6)
  assert.deepEqual(remote.calls.projectionSessionIds, ids, 'All reads every selected row in order')
  assert.deepEqual({ total: result.total, catalogTotal: result.catalogTotal }, { total: 6, catalogTotal: 6 })
})

test('a malformed updatedSince falls back to All instead of inventing a window', async () => {
  const ids = ['recent-a', 'edge-b', 'old-c', 'ancient-d', 'undated-e', 'undated-f']
  const remote = makeRemote(mixedItems(), projectionMapFor(ids))
  const result = await client.loadHistory(remote, undefined, { updatedSince: 'yesterday' })
  assert.equal(result.rows.length, 6)
  assert.deepEqual({ total: result.total, catalogTotal: result.catalogTotal }, { total: 6, catalogTotal: 6 })
})

test('a filter matching nothing returns an empty selection while the catalog stays whole', async () => {
  const remote = makeRemote(mixedItems(), projectionMapFor([]))
  const progress = []
  const result = await client.loadHistory(remote, undefined, { updatedSince: CUTOFF_30D, project: 'nope', onProgress: (p) => progress.push(p) })
  assert.deepEqual(plain(result.rows), [])
  assert.deepEqual(remote.calls.projectionSessionIds, [], 'nothing selected means no projection reads')
  assert.deepEqual({ total: result.total, available: result.available, failed: result.failed, catalogTotal: result.catalogTotal }, { total: 0, available: 0, failed: 0, catalogTotal: 6 })
  assert.deepEqual(plain(progress), [{ total: 0, available: 0, failed: 0, catalogTotal: 6, projectCount: 3 }])
})

test('with 924 listed sessions a 30-day window reads only the recent rows', async () => {
  const items = []
  for (let i = 0; i < 920; i += 1) items.push(row(`old-${i}`, { project: 'oldproj', updatedAt: Date.parse('2025-01-01T00:00:00Z') }))
  for (let i = 0; i < 4; i += 1) items.push(row(`new-${i}`, { project: 'newproj', updatedAt: NOW - i * 3600000 }))
  const remote = makeRemote(okValue({ items }), projectionMapFor(['new-0', 'new-1', 'new-2', 'new-3']))
  const result = await client.loadHistory(remote, undefined, { updatedSince: CUTOFF_30D })
  assert.equal(remote.calls.projectionSessionIds.length, 4, 'projection reads are bounded to the recent rows, not all 924')
  assert.deepEqual([...new Set(remote.calls.projectionSessionIds)].sort(), ['new-0', 'new-1', 'new-2', 'new-3'])
  assert.deepEqual({ total: result.total, catalogTotal: result.catalogTotal }, { total: 4, catalogTotal: 924 })
  assert.deepEqual(plain(result.projects), ['oldproj', 'newproj'], 'the project catalog still spans all metadata')
})

test('list metadata is still listed whole — filtering never narrows the list call', async () => {
  const remote = makeRemote(mixedItems(), projectionMapFor(['recent-a']))
  await client.loadHistory(remote, undefined, { updatedSince: CUTOFF_30D, project: 'alpha' })
  assert.equal(remote.calls.list.length, 1)
  assert.deepEqual(plain(remote.calls.list[0].query), {}, 'the list call stays the unchanged empty query')
})

// ---------- (6) loadHistory-level abort contract for a superseded read ----------

test('a superseded read is aborted mid-flight and its late outcome never lands', async () => {
  const items = okValue({ items: [row('slow-1'), row('slow-2')] })
  const remote = makeGatedRemote(items)
  const first = new AbortController()
  let settled = null
  const firstRun = client.loadHistory(remote, first.signal, { updatedSince: CUTOFF_30D })
    .then(() => { settled = 'resolved' }, (error) => { settled = error && error.name })
  while (remote.calls.projections.length < 2) await new Promise((resolve) => setImmediate(resolve))

  // The UI replaces this read: its signal aborts, and the fake host call rejects like the
  // real one would.
  first.abort()
  for (const call of remote.calls.projections) {
    call.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
  }
  assert.equal(await firstRun.catch(() => undefined), undefined, 'the aborted read rejects')
  assert.equal(settled, 'AbortError', 'and rejects as an abort, never as a partial success')

  // The late results the old read was waiting on arrive afterwards — nothing can land.
  for (const call of remote.calls.projections) call.resolve(okResult(stats()))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, 'AbortError', 'a late projection outcome cannot turn an aborted read into success')
})

// ---------- (4) cached projections are used without a cold read ----------

test('valid cached stats with usage are taken from the list item without any projection read', async () => {
  const cached = stats({ inputTokens: 9000, usageReports: 2 })
  const items = okValue({ items: [row('warm', { projections: { values: { ponytailStats: cached } } })] })
  const remote = makeRemote(items, new Map()) // any cold read would return undefined and fail the row
  const result = await client.loadHistory(remote, undefined)
  assert.deepEqual(remote.calls.projectionSessionIds, [], 'warm cache means zero projection reads')
  assert.equal(result.rows[0].status, 'available')
  assert.deepEqual(result.rows[0].stats, plain(cached))
  assert.deepEqual({ total: result.total, available: result.available, failed: result.failed }, { total: 1, available: 1, failed: 0 })
})

test('a warm cache with usageReports 0 is no-usage without a cold read, and malformed cached stats still fall through to the cold path', async () => {
  const items = okValue({ items: [
    row('warmzero', { projections: { values: { ponytailStats: stats({ usageReports: 0 }) } } }),
    row('warmbad', { projections: { values: { ponytailStats: { inputTokens: 'many' } } } }),
  ] })
  const remote = makeRemote(items, new Map([['warmbad', okResult(stats({ inputTokens: 5 }))]]))
  const result = await client.loadHistory(remote, undefined)
  assert.deepEqual(remote.calls.projectionSessionIds, ['warmbad'], 'only the malformed row gets a cold read')
  const byId = new Map(result.rows.map((r) => [r.sessionId, r]))
  assert.equal(byId.get('warmzero').status, 'no-usage')
  assert.equal(byId.get('warmzero').stats, null)
  assert.equal(byId.get('warmbad').status, 'available')
  assert.deepEqual({ available: result.available, failed: result.failed }, { available: 1, failed: 1 })
})
