// Regression test for the live user-reported dashboard error:
//   cannot get property "remote.session" without inject
//
// This test mounts the ACTUAL published client.js `apply` inside REAL extracted rc3
// Cordis (`Context`, `Service`). Cordis's ReflectService proxy throws
// `cannot get property "<name>" without inject` for any service a fiber did not
// declare, so the old code — which injected only `remote` and then read
// `remote.commands` / `remote.session` — fails here against the real lifecycle, not
// against a fake dependency check. No model, network, or app calls; no live profile.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')

// ---------- DSH_ROOT (required) ----------
// The test runs from <repo>/outputs/dsh-ponytail/test; the extracted rc3 runtime —
// including @deepseek-ai/cordis — lives at <repo>/work/rc3-runtime/dsh. There is no
// directory-candidate fallback: DSH_ROOT must be set explicitly, like every other
// test in this suite.
function requireDshRoot() {
  if (!process.env.DSH_ROOT) throw new Error('DSH_ROOT is required: set DSH_ROOT to the extracted rc3 runtime root (the directory containing node_modules/@deepseek-ai/cordis/lib/index.js)')
  const cordisEntry = path.join(process.env.DSH_ROOT, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')
  if (!fs.existsSync(cordisEntry)) throw new Error(`DSH_ROOT has no cordis runtime: ${cordisEntry}`)
  return process.env.DSH_ROOT
}

const dshRoot = requireDshRoot()
const cordis = await import(pathToFileURL(path.resolve(dshRoot, 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href)
const { Context, Service } = cordis

// ---------- load the ACTUAL client wrapper (same vm capture as client.test.mjs) ----------

function loadClientModule() {
  const source = fs.readFileSync(clientPath, 'utf8')
  let captured = null
  // The module realm also gets a DOM-ish surface: client.apply's effects and event
  // handlers use bare `document` / `window`, which resolve through that realm.
  const dom = {
    styleAppends: [],
    document: {
      visibilityState: 'visible',
      createElement: (tag) => ({ tagName: String(tag).toUpperCase(), textContent: '', remove() {} }),
      head: { append: (node) => dom.styleAppends.push(node) },
    },
    // Window handlers are only reached through component render, which this fixture
    // never performs; a stub keeps the realm complete.
    window: {
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true },
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
  // Minimal DOM surface for the vm realm: client.js's picker onSelect dispatches a real
  // `new CustomEvent(...)`, which Node's vm sandbox does not supply. A minimal class is
  // enough — no injection-behaviour checks live here; real Cordis supplies the boundary.
  class CustomEventStub {
    constructor(type, init) {
      this.type = String(type)
      this.detail = init && init.detail
    }
  }

  const sandbox = { document: dom.document, window: dom.window, CustomEvent: CustomEventStub }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: clientPath })
  if (!captured) throw new Error('window.__ModuleLoader__.load was never called by client.js')
  const exports = captured.factory((specifier) => {
    if (specifier === 'react') return reactStub()
    throw new Error(`unexpected require('${specifier}') from the client factory`)
  })
  return { exports, dom }
}

// React surface for createElement-only fixtures: elements are plain data, no component
// ever renders here, so hooks must never be reached.
function reactStub() {
  const fail = (name) => () => { throw new Error(`React.${name} must not be called by this fixture`) }
  const createElement = (type, props, ...children) => ({ type, props: props || null, children })
  return { createElement, useState: fail('useState'), useCallback: fail('useCallback'), useEffect: fail('useEffect') }
}

const loaded = loadClientModule()
const client = loaded.exports
assert.equal(typeof client.apply, 'function', 'client.js exports apply')

// ---------- fake DOM surface (apply's style effect uses document; handlers use window) ----------

// ---------- REAL rc3 Cordis fixture services ----------

class RemoteService extends Service {
  constructor(ctx, { session, commands }) {
    super(ctx, 'remote')
    this.session = session
    this.commands = commands
  }
}

function makeFixtures() {
  const registrations = []   // slots.register(options, component)
  const slotInjects = []     // [slotName, factory] pairs from slots.inject
  const decorations = []     // commandUi.decorate payloads
  const executed = []        // remote.commands.execute calls
  const listQueries = []     // remote.session.list calls
  const projectionQueries = []

  const sessionService = {
    async list(query, signal) {
      listQueries.push({ query, signal })
      return { ok: true, value: { items: [{ sessionId: 'sess-1', title: 'fixture session', cwd: '/w', project: 'p', updatedAt: Date.parse('2026-10-01T12:00:00Z') }] } }
    },
    async projections(query, signal) {
      projectionQueries.push({ query, signal })
      return {
        ok: true,
        value: {
          kind: 'sequenced',
          values: {
            ponytailStats: {
              inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, cacheWriteTokens: 5,
              usageReports: 3, turns: 2, activeMs: 5000, openTurnStart: null,
            },
          },
        },
      }
    },
  }

  const commandsService = {
    async execute(sessionId, line, attachments) {
      executed.push({ sessionId, line, attachments })
      if (line.indexOf('/ponytail') !== 0) return { ok: false, error: { message: 'unrecognised command in this fixture' } }
      return { ok: true, value: null }
    },
  }

  const scope = {
    // The host config form answers with a plain snapshot object; mutate resolves to the
    // updated snapshot (never `false`, which production reads as a refusal).
    getSnapshot: () => ({ status: 'ready', writable: true, revision: 1, value: { defaultMode: 'full', disabledSkills: [], showBand: true, expandedBand: false } }),
    subscribe: () => () => {},
    mutate: async () => ({ status: 'ready', writable: true, revision: 2, value: {} }),
  }

  return {
    registrations, slotInjects, decorations, executed, listQueries, projectionQueries, scope,
    provideAll(ctx) {
      ctx.provide('locale', { bind: (ns) => (key) => key, register: () => {} })
      ctx.provide('slots', {
        inject: (slotName, factory) => { slotInjects.push([slotName, factory]); return factory() },
        register: (options, component) => { registrations.push({ options, component }); return () => {} },
      })
      ctx.provide('configForms', { get: (id) => (id === 'ponytail' ? scope : null) })
      ctx.provide('commandUi', { decorate: (decoration) => { decorations.push(decoration); return () => {} } })
      ctx.provide('connection', { rpc: { call: async () => ({ ok: true, value: { mode: 'full' } }) } })
      ctx.provide('layout', { selectPanel: () => {} })
      ctx.provide('uiWorkspace', { openSession: async () => ({ ok: true }) })
      // REAL Service subclass instances: the `remote` root service carries plain
      // fields only — session/commands are separate injected subservices, exactly like
      // the native rc3 host. `new Service(...)` registers them in this fiber and
      // traces ctx to the calling fiber, so real Cordis enforces missing injects.
      new RemoteService(ctx, { session: sessionService, commands: commandsService })
      ctx.provide('remote.session', sessionService)
      ctx.provide('remote.commands', commandsService)
    },
  }
}

function mountClient() {
  // The fixture services live in their OWN sibling plugin on the root context — not
  // inside the client fiber. Providing them in the client's own fiber would let nested
  // reads resolve without inject and mask the reported failure.
  const ctx = new Context()
  const fixtures = makeFixtures()
  const provider = ctx.plugin({ name: 'scope-fixture-provider', apply: (c) => fixtures.provideAll(c) })
  const fiber = ctx.plugin({ name: 'ponytail-client-test', apply: client.apply })
  return { ctx, provider, fiber, fixtures }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

// ---------- positive: the real fix — all three inject lists carry their nested remote subservice ----------

test('client.apply mounts under real Cordis and every surface gets its declared remote subservice', async () => {
  const { ctx, fiber, fixtures } = mountClient()
  try {
    await fiber
    await settle()

    // The style effect really ran (document.head.append), so the apply closure executed.
    assert.equal(loaded.dom.styleAppends.length, 1, 'the ponytail style element was appended to the fake head')

    // Registration must actually exist — a child that failed to load must not pass silently.
    const settingsReg = fixtures.registrations.find((r) => r.options.name === 'settings.plugins.tab' && r.options.id === 'ponytail')
    const bandReg = fixtures.registrations.find((r) => r.options.name === 'conversation.input.dock' && r.options.id === 'ponytail-band')
    const panelReg = fixtures.registrations.find((r) => r.options.name === 'sidebar.panellist' && r.options.id === 'ponytail-dashboard')
    const mainReg = fixtures.registrations.find((r) => r.options.name === 'main' && r.options.id === 'ponytail-dashboard')
    assert.ok(settingsReg, 'settings tab registered (configForms closure loaded)')
    assert.equal(settingsReg.component, client.SettingsCard)
    assert.ok(bandReg, 'status band registered (remote.commands closure loaded — old code silently skipped this)')
    assert.equal(bandReg.component, client.StatusBand)
    assert.ok(panelReg, 'sidebar panel row registered')
    assert.ok(mainReg, 'dashboard main panel registered (remote.session closure loaded — the reported failure)')
    assert.equal(mainReg.component, client.Dashboard)
    assert.equal(fixtures.decorations.length, 1, '/ponytail commandUi decoration exists (old code silently skipped this too)')

    // Dashboard props flow through the main registration's inject and satisfy loadHistory.
    const dashboardProps = mainReg.options.inject('sess-1')
    assert.ok(dashboardProps.remote && dashboardProps.remote.session, 'main panel receives remote.session')
    const history = await client.loadHistory(dashboardProps.remote, new AbortController().signal)
    assert.equal(history.total, 1)
    assert.equal(history.available, 1, 'cold session resolves through the injected fake session service')

    // Mode picker: only a /ponytail selection reaches the fake commands service.
    // The slot factory ran through slots.inject (the stub executes it), so the picker's
    // onSelect dispatches `new CustomEvent(...)` inside the vm realm — Node has no
    // CustomEvent, hence the minimal class in the sandbox.
    const decoration = fixtures.decorations[0]
    assert.equal(decoration.name, 'ponytail')
    const options = await decoration.ui.options()
    const ultra = options.find((option) => option.id === 'ultra')
    assert.ok(ultra, 'picker offers ultra')
    await decoration.ui.onSelect(ultra, { sessionId: 'sess-1' })
    assert.deepEqual(fixtures.executed.map((call) => call.line), ['/ponytail ultra'], 'only the scoped /ponytail command reached remote.commands')

    // Status band props flow through the dock registration's inject — including commands.
    const bandProps = bandReg.options.inject('sess-1')
    assert.ok(bandProps.remote && bandProps.remote.commands, 'band receives remote.commands')
    const bandResult = await bandProps.remote.commands.execute('sess-1', '/ponytail lite', [])
    assert.equal(bandResult.ok, true, 'same scoped commands service the band handler calls')

    // Nothing outside the declared scope was touched.
    for (const call of fixtures.executed.concat()) {
      assert.equal(call.line.indexOf('/ponytail'), 0)
    }
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

// ---------- negative controls: real Cordis rejects the OLD inject shape ----------

test('negative control: injecting only "remote" makes remote.session throw in real Cordis', async () => {
  const { ctx, fiber } = mountClient()
  try {
    await fiber
    await settle()
    // The OLD production shape — inject ['remote'] then read services.remote.session —
    // must be rejected by the actual ReflectService, which is what the user saw.
    const scoped = ctx.inject(['remote'], (services) => void services.remote.session)
    await assert.rejects(async () => await scoped, /cannot get property "remote\.session" without inject/)
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

test('negative control: injecting only "remote" makes remote.commands throw in real Cordis', async () => {
  const { ctx, fiber } = mountClient()
  try {
    await fiber
    await settle()
    const scoped = ctx.inject(['remote'], (services) => void services.remote.commands)
    await assert.rejects(async () => await scoped, /cannot get property "remote\.commands" without inject/)
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})
