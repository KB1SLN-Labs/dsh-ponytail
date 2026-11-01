// Unit tests for @kb1slnlabs/dsh-ponytail against the REAL installed DSH host
// services (no model calls, no network). DSH_ROOT is REQUIRED and must point at
// the @deepseek-ai/dsh package directory (the parent sets work/rc3-runtime/dsh);
// there is deliberately NO scan/fallback to a global CLI install, and the host
// dsh-llm version is verified. Production code uses bare peer specifiers only;
// these tests import the plugin after creating a junction from the package dir
// to an isolated node_modules that links the installed host packages (never a
// live profile).
//
// Agent stubs: `fakeAgent` is a plain object implementing just inject/followup/
// session.append — the command handlers and pre-step hook are exercised for
// real, but NO live Agent loop or LLM is involved. Nothing here proves model
// behaviour; it proves wiring against the real host services.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.join(here, '..')

const REQUIRED_DSH_LLM_VERSION = process.env.DSH_TEST_VERSION || '0.2.1-rc.3'

function locateDshModules() {
  // DSH_ROOT is required and points at the DSH package directory (the parent
  // sets work/rc3-runtime/dsh). No scan/fallback to a global CLI install.
  if (!process.env.DSH_ROOT) throw new Error('DSH_ROOT must point at the @deepseek-ai/dsh package directory (e.g. work/rc3-runtime/dsh); no global-CLI fallback')
  const hostModules = path.join(process.env.DSH_ROOT, 'node_modules')
  if (!fs.existsSync(hostModules)) throw new Error(`DSH_ROOT has no node_modules: ${hostModules}`)
  const llmPkg = path.join(hostModules, '@deepseek-ai', 'dsh-llm', 'package.json')
  if (!fs.existsSync(llmPkg)) throw new Error(`host dsh-llm package not found at ${llmPkg}`)
  const { version } = JSON.parse(fs.readFileSync(llmPkg, 'utf8'))
  if (version !== REQUIRED_DSH_LLM_VERSION) throw new Error(`host dsh-llm version is ${version}, expected exactly ${REQUIRED_DSH_LLM_VERSION}`)
  return hostModules
}

const hostModules = locateDshModules()
// Isolated peer tree for the package under test: <pkg>/node_modules junction →
// the installed dsh host modules. Created once per run and removed when the
// suite exits, so a plain checkout never keeps a stray node_modules (and
// `npm pack` stays clean).
const link = path.join(pkgDir, 'node_modules')
let createdLink = false
if (!fs.existsSync(link)) {
  fs.symlinkSync(hostModules, link, 'junction')
  createdLink = true
} else if (!fs.lstatSync(link).isSymbolicLink()) {
  throw new Error(`${link} exists and is not the test junction — refusing to touch it`)
}

function cleanup() {
  // unlinkSync removes ONLY the junction/symlink we created, never its target
  // tree (recursive rm of a junction could delete host modules). Runs from
  // process.on('exit') — after every module has settled.
  if (createdLink) { try { fs.unlinkSync(link) } catch {} }
}
process.on('exit', cleanup)

const mod = await import(pathToFileURL(path.join(pkgDir, 'index.js')).href)
const { Context } = await import(pathToFileURL(path.join(hostModules, '@deepseek-ai/cordis/lib/index.js')).href)
const SystemPrompt = (await import(pathToFileURL(path.join(hostModules, '@deepseek-ai/dsh-system-prompt/lib/index.js')).href)).default
const SkillRegistry = (await import(pathToFileURL(path.join(hostModules, '@deepseek-ai/dsh-skill/lib/index.js')).href)).default
const CommandRuntime = (await import(pathToFileURL(path.join(hostModules, '@deepseek-ai/dsh-commands/lib/index.js')).href)).default

// Upstream config isolation: point XDG_CONFIG_HOME at a temp dir under an
// explicit test work root (never the user's real one). The path is verified to
// resolve inside workRoot before use.
const testWork = process.env.PONYTAIL_TEST_WORK || path.join(os.tmpdir(), 'dsh-ponytail-tests')
fs.mkdirSync(testWork, { recursive: true })
const workRoot = fs.realpathSync(testWork)
const tmpBase = path.join(workRoot, '.dsh-ponytail-test-tmp')
fs.mkdirSync(tmpBase, { recursive: true })
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, 'cfg-')))
if (!tmp.startsWith(workRoot + path.sep)) throw new Error(`test temp root ${tmp} escaped ${workRoot}`)
process.env.XDG_CONFIG_HOME = path.join(tmp, 'config')
delete process.env.PONYTAIL_DEFAULT_MODE

function makeCtx() {
  const ctx = new Context()
  new SystemPrompt(ctx, {})
  new SkillRegistry(ctx)
  return ctx
}

async function mount(config, options = {}) {
  const ctx = makeCtx()
  const fiber = await ctx.plugin(mod, config ?? {})
  if (options.commands) {
    new CommandRuntime(ctx)
    await new Promise(resolve => setImmediate(resolve))
  }
  return {
    ctx,
    fiber,
    prompt: ctx.get('systemPrompt'),
    skills: ctx.get('skills'),
    commands: options.commands ? ctx.get('commands') : undefined,
  }
}

/** Read a config value the way the plugin does (volatile reference or plain value). */
function readConfigValue(ref) {
  return ref && typeof ref === 'object' && Symbol.for('cosmokit.volatile.write') in ref ? ref.get() : ref
}

/** The live volatile references the fiber is running on, keyed by field name. */
function liveConfigRefs(fiber) {
  const refs = {}
  for (const [key, value] of Object.entries(fiber.config ?? {})) {
    if (value && typeof value === 'object' && Symbol.for('cosmokit.volatile.write') in value) refs[key] = value
  }
  return refs
}

async function skillNames(skills) {
  return (await skills.list({})).map(s => s.name).sort()
}

async function commandNames(commands, agent) {
  return (await commands.list(agent)).map(c => c.name).sort()
}

// The volatile write channel is a Symbol.for key owned by the reference itself —
// cosmokit's createVolatile/updateVolatile are the only writers. Tests commit a
// change through that same symbol, which is exactly what the Loader does before it
// emits loader/volatile-update.
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

function writeConfigRef(ref, value) {
  if (typeof ref[VOLATILE_WRITE] !== 'function') throw new Error('config reference has no volatile write channel')
  ref[VOLATILE_WRITE](value)
}

/** Effective prompt text for one scope (an agent-like object). */
async function sectionText(prompt, scope) {
  const assembly = await prompt.assemble({ scope })
  const section = assembly.sections.find(s => s.name === 'ponytail')
  return section?.text ?? ''
}

function fakeAgent(id, cwd = tmp) {
  const injected = []
  const followups = []
  return {
    id,
    injected,
    followups,
    session: { id, header: { cwd } },
    inject: (m) => injected.push(m),
    followup: (m) => followups.push(m),
  }
}

async function runCommand(commands, agent, line, attachments = []) {
  // Drive the handler through the real registry path, with a session stub that
  // absorbs the command/run and command/done lifecycle appends.
  agent.session.append = () => Promise.resolve({ seq: 1 })
  const execution = await commands.execute(agent, line, attachments, new AbortController().signal)
  return execution?.result
}

test('module surface: name/inject/Config/apply, no default export', () => {
  assert.equal(mod.name, 'ponytail')
  assert.deepEqual(mod.inject, ['systemPrompt', 'skills'])
  assert.equal(typeof mod.apply, 'function')
  assert.ok(mod.Config)
  assert.equal(mod.default, undefined, 'no default export (Loader unwrapExports would collapse it)')
  assert.equal(mod.messageText, undefined, 'no exported helper the tests do not need')
})

test('Config validates documented levels and rejects junk loudly', () => {
  // Every Config field is .volatile(), so a direct validate() returns cosmokit
  // references; read them the way the plugin does (this is also the unit stub for
  // the volatile path — the loader test below exercises the real reference).
  const value = fields => {
    const parsed = mod.Config(fields)
    const out = {}
    for (const key of Object.keys(parsed)) {
      const ref = parsed[key]
      out[key] = ref && typeof ref === 'object' && Symbol.for('cosmokit.volatile.write') in ref ? ref.get() : ref
    }
    return out
  }
  for (const mode of ['full', 'lite', 'ultra', 'off', 'inherit']) {
    assert.equal(value({ defaultMode: mode }).defaultMode, mode)
  }
  assert.equal(value({}).defaultMode, 'inherit')
  assert.throws(() => mod.Config({ defaultMode: 'turbo' }))
  assert.throws(() => mod.Config({ defaultMode: 42 }))
})

test('Config: new settings fields — defaults, volatile refs, and loud rejection', () => {
  const raw = mod.Config({})
  for (const key of ['defaultMode', 'disabledSkills', 'showBand', 'expandedBand']) {
    assert.ok(raw[key] && typeof raw[key] === 'object' && Symbol.for('cosmokit.volatile.write') in raw[key], `${key} is a volatile reference`)
  }
  const defaults = {}
  for (const key of Object.keys(raw)) defaults[key] = raw[key].get()
  assert.deepEqual(defaults, { defaultMode: 'inherit', disabledSkills: [], showBand: true, expandedBand: false })
  // The enum accepts ONLY the five optional names: disabling the core 'ponytail'
  // skill is rejected loudly (the core ruleset, the ponytail skill and /ponytail
  // are never removable), so this must throw for core.
  const optional = ['ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help']
  assert.deepEqual(mod.Config({ disabledSkills: optional }).disabledSkills.get(), optional)
  assert.throws(() => mod.Config({ disabledSkills: ['ponytail'] }), 'core skill cannot be disabled via config')
  assert.throws(() => mod.Config({ disabledSkills: ['not-a-skill'] }))
  assert.throws(() => mod.Config({ disabledSkills: 'ponytail-help' }))
  assert.equal(mod.Config({ showBand: false, expandedBand: true }).showBand.get(), false)
  assert.throws(() => mod.Config({ showBand: 'yes' }))
})

test('always-on section: full/lite/ultra filtering; off returns empty; other sections preserved', async () => {
  const { ctx, prompt } = await mount({ defaultMode: 'full' })
  const agent = fakeAgent('a-full')
  const full = await sectionText(prompt, agent)
  assert.match(full, /PONYTAIL MODE ACTIVE — level: full/)
  assert.match(full, /lazy senior developer/)
  // Mode filtering: the level-keyed rows differ between levels.
  const ultra = await (async () => {
    const m = await mount({ defaultMode: 'ultra' })
    return sectionText(m.prompt, fakeAgent('a-ultra'))
  })()
  assert.match(ultra, /level: ultra/)
  assert.notEqual(full, ultra)
  const lite = await (async () => {
    const m = await mount({ defaultMode: 'lite' })
    return sectionText(m.prompt, fakeAgent('a-lite'))
  })()
  assert.match(lite, /level: lite/)
  const off = await (async () => {
    const m = await mount({ defaultMode: 'off' })
    return sectionText(m.prompt, fakeAgent('a-off'))
  })()
  assert.equal(off, '', 'off must contribute an empty section (upstream builder alone does not)')
  // Other sections survive: identity is still there, and our section did not replace it.
  const assembly = await prompt.assemble({ scope: agent })
  assert.ok(assembly.sections.some(s => s.name === 'harness:identity'))
  assert.ok(assembly.sections.some(s => s.name === 'ponytail'))
  void ctx
})

test('host contract: a complete:true section replaces the whole prompt (Ponytail suppressed)', async () => {
  const { ctx, prompt } = await mount({ defaultMode: 'full' })
  const agent = fakeAgent('a-complete')
  assert.match(await sectionText(prompt, agent), /level: full/, 'normal assembly keeps Ponytail')
  const dispose = ctx.systemPrompt.section({ name: 'preset-complete', order: 1, complete: true, text: 'COMPLETE PRESET PROMPT' })
  const assembly = await prompt.assemble({ scope: agent })
  assert.deepEqual(assembly.sections.map(s => s.name), ['preset-complete'], 'complete section becomes the sole prompt')
  assert.equal(assembly.sections[0].text, 'COMPLETE PRESET PROMPT')
  dispose()
  assert.match(await sectionText(prompt, agent), /level: full/, 'after the preset goes away Ponytail is back')
})

test('per-agent isolation: one session override does not leak to another agent', async () => {
  const { ctx, prompt } = await mount({ defaultMode: 'full' })
  const commands = new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  const a = fakeAgent('agent-a')
  const b = fakeAgent('agent-b')
  const result = await runCommand(commands, a, '/ponytail ultra')
  assert.equal(result.kind, 'success')
  assert.match(await sectionText(prompt, a), /level: ultra/)
  assert.match(await sectionText(prompt, b), /level: full/)
  // The switch left a model-visible notice via inject (not followup).
  assert.equal(a.injected.length, 1)
  assert.match(a.injected[0].content[0].text, /PONYTAIL MODE CHANGED — level: ultra/)
  assert.equal(b.injected.length, 0)
})

test('agent/disposed clears the session override', async () => {
  const { ctx, prompt } = await mount({ defaultMode: 'full' })
  const commands = new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  const a = fakeAgent('agent-dying')
  await runCommand(commands, a, '/ponytail off')
  assert.equal(await sectionText(prompt, a), '')
  ctx.emit('agent/disposed', { agent: a })
  assert.match(await sectionText(prompt, a), /level: full/)
})

test('bare /ponytail keeps an active mode; from off it re-enables at the default (full when default is off)', async () => {
  const { ctx, prompt } = await mount({ defaultMode: 'off' })
  const commands = new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  const a = fakeAgent('a-bare')
  assert.match((await runCommand(commands, a, '/ponytail')).text, /Ponytail mode set to full/)
  assert.match(await sectionText(prompt, a), /level: full/)
  // Bare again while active: status, no change.
  const second = await runCommand(commands, a, '/ponytail')
  assert.equal(second.kind, 'success')
  assert.match(await sectionText(prompt, a), /level: full/)
})

test('invalid input leaves session state untouched', async () => {
  const { ctx, prompt } = await mount({ defaultMode: 'full' })
  const commands = new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  const a = fakeAgent('a-invalid')
  for (const line of ['/ponytail turbo', '/ponytail default turbo', '/ponytail lite extra', '/ponytail status now', '/ponytail review']) {
    const result = await runCommand(commands, a, line)
    assert.equal(result.kind, 'error', `${line} rejected`)
  }
  assert.match(await sectionText(prompt, a), /level: full/)
  assert.equal(a.injected.length, 0, 'invalid input must not inject a notice')
})

test('reset and status', async () => {
  const { ctx, prompt } = await mount({ defaultMode: 'full' })
  const commands = new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  const a = fakeAgent('a-reset')
  await runCommand(commands, a, '/ponytail lite')
  assert.match(await sectionText(prompt, a), /level: lite/)
  const status = await runCommand(commands, a, '/ponytail status')
  assert.match(status.text, /lite — session override/)
  const reset = await runCommand(commands, a, '/ponytail reset')
  assert.equal(reset.kind, 'success')
  assert.match(await sectionText(prompt, a), /level: full/)
})

test('status reports the profile config default, not the global file it cannot reach', async () => {
  const { ctx } = await mount({ defaultMode: 'ultra' })
  const commands = new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  const a = fakeAgent('a-status-cfg')
  const status = await runCommand(commands, a, '/ponytail status')
  assert.match(status.text, /Ponytail: ultra — profile config\.defaultMode \(ultra\)/)
})

test('regression: profile config=ultra + saved global default lite → saved lite but still ultra', async () => {
  const { ctx, prompt } = await mount({ defaultMode: 'ultra' })
  const commands = new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  const a = fakeAgent('a-prec')
  const saved = await runCommand(commands, a, '/ponytail default lite')
  assert.equal(saved.kind, 'success')
  assert.match(saved.text, /Saved global ponytail default: lite/)
  assert.match(saved.text, /config\.defaultMode \(ultra\) still overrides/, 'honest precedence note')
  const configFile = path.join(process.env.XDG_CONFIG_HOME, 'ponytail', 'config.json')
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).defaultMode, 'lite', 'global file really says lite')
  assert.match(await sectionText(prompt, a), /level: ultra/, 'profile config still wins')
  const status = await runCommand(commands, a, '/ponytail status')
  assert.match(status.text, /Ponytail: ultra — profile config\.defaultMode \(ultra\)/)
})

test('default <mode> writes the upstream global default file (test-local path) and reports write failure', async () => {
  const { ctx } = await mount({ defaultMode: 'inherit' })
  const commands = new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  const a = fakeAgent('a-default')
  const result = await runCommand(commands, a, '/ponytail default lite')
  assert.equal(result.kind, 'success')
  const configFile = path.join(process.env.XDG_CONFIG_HOME, 'ponytail', 'config.json')
  assert.ok(fs.existsSync(configFile), 'upstream config file written under the test XDG_CONFIG_HOME')
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).defaultMode, 'lite')
  // A hostile default dir makes the write fail and the command report it:
  // XDG_CONFIG_HOME points at a regular file, so mkdir cannot create the dir.
  const blocked = path.join(tmp, 'blocked')
  fs.writeFileSync(blocked, 'not a directory')
  const saved = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = blocked
  try {
    const failed = await runCommand(commands, fakeAgent('a-default-2'), '/ponytail default ultra')
    assert.equal(failed.kind, 'error')
    assert.match(failed.text, /Failed to save default/)
  } finally {
    process.env.XDG_CONFIG_HOME = saved
  }
})

test('headless without commands: ruleset still mounts, no command registry needed', async () => {
  const { ctx, prompt } = await mount({ defaultMode: 'full' })
  await new Promise(resolve => setImmediate(resolve))
  const assembly = await prompt.assemble({ scope: fakeAgent('a-headless') })
  assert.ok(assembly.sections.some(s => s.name === 'ponytail' && s.text.includes('PONYTAIL MODE ACTIVE')))
  // No `commands` service was ever composed — apply() must not have thrown.
  assert.equal(ctx.get('commands'), undefined)
})

test('six upstream skills registered with real metadata and upstream bodies', async () => {
  const { ctx, skills } = await mount({ defaultMode: 'full' })
  const list = await skills.list({})
  const names = list.map(s => s.name).sort()
  assert.deepEqual(names, ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review'])
  for (const s of list) {
    assert.equal(s.source, 'bundled')
    assert.ok(s.description.length > 0)
    assert.equal(s.invocation.modelInvocable, true)
    assert.equal(s.invocation.userInvocable, true)
  }
  const review = await skills.get('ponytail-review', {})
  assert.ok(review.path.endsWith(path.join('skills', 'ponytail-review', 'SKILL.md')))
  assert.equal(review.resourceBase.kind, 'directory')
  // 5.3.3 review body covers quality AND security/scale/tests/speed/lean — not the legacy over-engineering-only text.
  assert.match(review.content, /security/i)
  assert.match(review.content, /\*\*Bug:\*\* wrong result, crash, missed edge case/)
  assert.match(review.content, /Missing test/)
  assert.match(review.content, /\*\*Lean:\*\* code that should not exist/)
  const help = await skills.get('ponytail-help', {})
  // DSH-adapted help card (the one host adaptation): DSH commands, no Claude band/update flow.
  assert.match(help.content, /\/ponytail status|\/ponytail reset/)
  assert.doesNotMatch(help.content, /Claude Code|\/plugin|band import/)
  const debt = await skills.get('ponytail-debt', {})
  assert.match(debt.content, /shortcut: <ceiling>, <upgrade path>/)
  const gain = await skills.get('ponytail-gain', {})
  assert.match(gain.content, /benchmark/i)
})

test('plain (non-volatile) config: disabledSkills removes ONLY the optional skill + command', async () => {
  // A headless/older host hands apply() plain values — configValue() must pass them
  // through and nothing may call .get() on them.
  const { ctx, skills } = await mount({ defaultMode: 'full', disabledSkills: ['ponytail-help'] })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await skillNames(skills), ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-review'])
  const commands = new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await commandNames(commands, fakeAgent('a-plain-cfg')), ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-review'])
})

test('headless (no commands service): all six skills still mount', async () => {
  const { ctx, skills } = await mount({ defaultMode: 'full' })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ctx.get('commands'), undefined, 'no command registry composed')
  assert.deepEqual(await skillNames(skills), ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review'])
})

test('live volatile disabledSkills change: exact skill + command membership; core /ponytail always stays', async () => {
  const { ctx, fiber, skills, commands } = await mount({ defaultMode: 'full' }, { commands: true })
  // The running config really is a set of cosmokit volatile references.
  const refs = liveConfigRefs(fiber)
  for (const key of ['defaultMode', 'disabledSkills', 'showBand', 'expandedBand']) {
    assert.ok(refs[key], `${key} is a live volatile reference on the fiber`)
  }
  assert.deepEqual(await skillNames(skills), ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review'])
  const before = await commandNames(commands, fakeAgent('a-live-1'))
  assert.deepEqual(before, ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review'])

  // Commit a change the way the Loader does: write into the running references, then
  // emit loader/volatile-update. No remount, so nothing else is rebuilt.
  // ONLY optional skills may be named — the core 'ponytail' skill and the /ponytail
  // mode command are never removable, so both must survive every pass.
  writeConfigRef(refs.disabledSkills, ['ponytail-gain', 'ponytail-help'])
  ctx.emit('loader/volatile-update', [['disabledSkills']])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await skillNames(skills), ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-review'])
  const afterDisable = await commandNames(commands, fakeAgent('a-live-2'))
  assert.deepEqual(afterDisable, ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-review'])
  // The disabled optional commands really are gone, not merely hidden.
  for (const gone of ['ponytail-gain', 'ponytail-help']) {
    assert.ok(!afterDisable.includes(gone), `${gone} command removed from the registry`)
  }

  // And back again: the removed rows come back, nothing duplicated.
  writeConfigRef(refs.disabledSkills, [])
  ctx.emit('loader/volatile-update', [['disabledSkills']])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await skillNames(skills), ['ponytail', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help', 'ponytail-review'])
  assert.deepEqual(await commandNames(commands, fakeAgent('a-live-3')), before)

  // The core skill AND the core mode command survived every pass, and an in-memory
  // session override set through /ponytail is still in effect afterwards.
  assert.ok((await skillNames(skills)).includes('ponytail'), 'core ponytail skill present after every volatile pass')
  const a = fakeAgent('a-live-core')
  const setUltra = await runCommand(commands, a, '/ponytail ultra')
  assert.equal(setUltra.kind, 'success')
  const result = await runCommand(commands, a, '/ponytail status')
  assert.match(result.text, /ultra — session override/, 'mode override survives the volatile passes')
})

test('live volatile defaultMode change keeps the session override; reset falls back to the new default', async () => {
  const { ctx, fiber, prompt, commands } = await mount({ defaultMode: 'full' }, { commands: true })
  const refs = liveConfigRefs(fiber)
  const a = fakeAgent('a-mode-live')
  await runCommand(commands, a, '/ponytail lite')
  assert.match(await sectionText(prompt, a), /level: lite/, 'session override wins')
  const statusBefore = await runCommand(commands, a, '/ponytail status')
  assert.match(statusBefore.text, /lite — session override/)

  writeConfigRef(refs.defaultMode, 'ultra')
  ctx.emit('loader/volatile-update', [['defaultMode']])
  await new Promise(resolve => setImmediate(resolve))
  assert.match(await sectionText(prompt, a), /level: lite/, 'the ModeStore override survives the volatile change')
  const statusAfter = await runCommand(commands, a, '/ponytail status')
  assert.match(statusAfter.text, /lite — session override/)
  // A fresh agent with no override sees the NEW configured default.
  assert.match(await sectionText(prompt, fakeAgent('a-mode-live-2')), /level: ultra/)

  const reset = await runCommand(commands, a, '/ponytail reset')
  assert.equal(reset.kind, 'success')
  assert.match(await sectionText(prompt, a), /level: ultra/, 'reset now falls back to the live configured default')
})

test('gain skill resourceBase resolves the vendored benchmark file directly', async () => {
  const { skills } = await mount({ defaultMode: 'full' })
  const gain = await skills.get('ponytail-gain', {})
  assert.match(gain.content, /benchmarks[/\\]results[/\\]2026-10-07-agentic\.md/)
  assert.equal(gain.resourceBase.kind, 'directory')
  // The gain resource base is the package root, where the vendored benchmark
  // lives — so the skill's own relative path resolves directly, no '..' hops.
  const reachable = path.join(gain.resourceBase.path, 'benchmarks', 'results', '2026-10-07-agentic.md')
  assert.ok(fs.existsSync(reachable), 'benchmark report reachable from the rendered resource base')
})

test('all five one-shot handlers: canonical <skill_content>, upstream body, trailing args reach followup; no [object Promise]; mode unchanged', async () => {
  const { ctx, prompt } = await mount({ defaultMode: 'full' })
  const commands = new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  for (const skillName of ['ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help']) {
    const agent = fakeAgent(`oneshot-${skillName}`)
    const before = await sectionText(prompt, agent)
    const result = await runCommand(commands, agent, `/${skillName} focus on the auth module`)
    assert.equal(result.kind, 'success', `${skillName} settled success`)
    assert.equal(agent.injected.length, 0, 'one-shots must not inject (idle agents stay asleep)')
    assert.equal(agent.followups.length, 1, 'one-shots wake via followup')
    const text = agent.followups[0].content.map(b => b.text ?? '').join('\n')
    assert.doesNotMatch(text, /\[object Promise\]/)
    assert.match(text, new RegExp(`<skill_content name="${skillName}">`), 'canonical wrapper from dsh-skill renderSkillContent')
    assert.match(text, /<skill_instructions>/)
    assert.match(text, /focus on the auth module/, 'trailing user arguments retained')
    assert.deepEqual(agent.followups[0].source, { kind: 'skill-invocation', name: skillName, form: 'instructions' })
    assert.equal(await sectionText(prompt, agent), before, 'one-shots never switch the active mode')
  }
})

test('one-shot commands declare input.attachments:true and pass admitted attachments with the notes', async () => {
  const { ctx } = await mount({ defaultMode: 'full' })
  const commands = new CommandRuntime(ctx)
  // Test-only attachment stubs mirroring the REAL host shapes: submitted wire
  // attachments are { type:'image', mediaType, data } or { type:'file',
  // receiptId }; the executor admits images via dsh-attachment
  // admitEncodedImages → store.saveImages(inputs) and files via the registered
  // receipt resolver, and the handler receives frozen ImageBlock/FileBlocks.
  // This proves the declaration + pass-through wiring, not the host's own
  // admission internals (which are real code paths here).
  const store = {
    saveImages: async (inputs) => inputs.map(input => ({ id: `ref-${input.mediaType}`, mediaType: input.mediaType, bytes: input.data.byteLength })),
  }
  ctx.provide('attachments', store)
  commands.registerFileReceiptResolver(() => ({ id: 'att-file', name: 'diff.txt', bytes: 3, path: path.join(tmp, 'diff.txt') }))
  await new Promise(resolve => setImmediate(resolve))
  const declared = (await commands.list(fakeAgent('a-declare'))).find(c => c.name === 'ponytail-audit')
  assert.equal(declared.input.attachments, true, 'host-boolean attachment flag declared on every one-shot')
  fs.writeFileSync(path.join(tmp, 'diff.txt'), 'x y z')
  const agent = fakeAgent('a-attach')
  const result = await runCommand(commands, agent, '/ponytail-audit review this', [
    { type: 'image', mediaType: 'image/png', data: 'AAAA' },
    { type: 'file', receiptId: 'att-file' },
  ])
  assert.equal(result.kind, 'success', `attachments admitted because input.attachments === true (${result?.text})`)
  const blocks = agent.followups[0].content
  assert.match(blocks[0].text, /<skill_content name="ponytail-audit">/)
  assert.equal(blocks[1].text, 'review this', 'original user notes kept alongside attachments')
  assert.deepEqual(blocks.slice(2), [
    { type: 'image', attachment: { id: 'ref-image/png', mediaType: 'image/png', bytes: 3 } },
    { type: 'file', attachment: { id: 'att-file', name: 'diff.txt', bytes: 3, path: path.join(tmp, 'diff.txt') } },
  ], 'admitted ImageBlock/FileBlock reach the user message in submission order')
})

test('exact-phrase deactivation by a genuine human message turns the session off; everything else does not', async () => {
  const { ctx, prompt } = await mount({ defaultMode: 'full' })
  await new Promise(resolve => setImmediate(resolve))
  const agent = fakeAgent('a-deactivate')
  const preStep = ctx.events._hooks['agent/pre-step']
  assert.ok(preStep?.length, 'pre-step listener registered')
  const invoke = async (messages) => {
    let called = 0
    const next = async () => { called++; return { kind: 'enter', messages } }
    // Run the registered listeners exactly as the waterfall would (single ponytail listener).
    for (const hook of preStep) await hook.callback.call(ctx, { agent, messages, turn: 1, step: 1, signal: new AbortController().signal }, next)
    return called
  }
  const human = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  // Negatives FIRST (each must leave the level at full):
  assert.equal(await invoke([{ role: 'assistant', source: { kind: 'model', model: 'm' }, content: [{ type: 'text', text: 'stop ponytail' }] }]), 1)
  assert.match(await sectionText(prompt, agent), /level: full/, 'assistant text never deactivates')
  assert.equal(await invoke([{ role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'normal mode' }] }]), 1)
  assert.match(await sectionText(prompt, agent), /level: full/, 'tool-result text never deactivates')
  assert.equal(await invoke([human('please stop ponytail now')]), 1)
  assert.match(await sectionText(prompt, agent), /level: full/, 'quoted substring must NOT deactivate')
  assert.equal(await invoke([{ role: 'user', source: { kind: 'skill-invocation', name: 'ponytail-help', form: 'instructions' }, content: [{ type: 'text', text: 'normal mode' }] }]), 1)
  assert.match(await sectionText(prompt, agent), /level: full/, 'user-role skill-invocation content must NOT deactivate')
  assert.equal(await invoke([{ role: 'user', source: { kind: 'plugin', plugin: 'ponytail' }, content: [{ type: 'text', text: 'normal mode' }] }]), 1)
  assert.match(await sectionText(prompt, agent), /level: full/, 'plugin-injected instruction must NOT deactivate')
  // Positives: exact real human phrases.
  assert.equal(await invoke([human('Stop Ponytail!!')]), 1)
  assert.equal(await sectionText(prompt, agent), '', 'exact phrase (case/punctuation normalized) deactivates')
  const offBefore = await sectionText(prompt, agent)
  assert.equal(await invoke([human('normal mode please')]), 1)
  assert.equal(await sectionText(prompt, agent), offBefore, 'near-miss changes nothing')
  assert.equal(await invoke([human('normal mode')]), 1)
  assert.equal(await sectionText(prompt, agent), '', 'second exact phrase keeps it off')
})

test('disposal/unload: fiber disposal removes section and skills', async () => {
  const { ctx, fiber, prompt, skills } = await mount({ defaultMode: 'full' })
  assert.ok(ctx.get('systemPrompt'))
  assert.ok((await skills.list({})).length === 6)
  await fiber.dispose()
  const assembly = await prompt.assemble({ scope: fakeAgent('a-after') })
  assert.ok(!assembly.sections.some(s => s.name === 'ponytail'))
  assert.deepEqual(await skills.list({}), [])
})
