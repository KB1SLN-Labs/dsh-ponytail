// @kb1slnlabs/dsh-ponytail — Ponytail 5.3.3 "lazy senior dev mode" for the DeepSeek Harness.
//
// A Cordis namespace plugin: exports { name, inject, Config, apply } and NO default
// export (the Loader's unwrapExports would collapse a module that carries one).
// It contributes one dynamic system-prompt section (appended, never replacing other
// sections), registers the six upstream Ponytail skills in ctx.skills, registers the
// /ponytail mode command plus five one-shot skill commands when a command registry
// is composed, and honours the upstream plain-text deactivation phrases.
//
// Instruction text, mode filtering, default-mode resolution, and the global default
// file all come from the vendored upstream modules (hooks/ponytail-instructions.js,
// hooks/ponytail-config.js) — no rules are rewritten here. See README.md for the
// exact upstream SHA and every host-specific deviation.
//
// Host peers (@deepseek-ai/schemastery, @deepseek-ai/dsh-llm, @deepseek-ai/dsh-skill)
// are declared as peerDependencies and imported as bare specifiers: installed via
// pnpm into the profile directory that anchors plugin resolution. No path is hardcoded.

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Canonical <skill_content> renderer — the harness's own, exported by dsh-skill
// (a required peer). Static import: no lazy wrapper, no fallback path.
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
// Local metrics module (in this package, so no new peer): the ponytailStats
// projection unit and the read-only effective-state route helpers. zod is a
// host-declared OPTIONAL peer (the host's own stats/projection packages depend
// on it), declared in package.json peerDependencies + peerDependenciesMeta.
import { ponytailStatsProjectionDefinition, parsePonytailStateRequest, PONYTAIL_STATE_PATH, recordedTestResult } from './metrics.js'

const require = createRequire(import.meta.url)
// The vendored upstream modules keep their CommonJS form (hooks/package.json pins
// "type": "commonjs"); bridge to them from this ES module exactly as upstream's own
// opencode plugin does.
const { getPonytailInstructions } = require('./hooks/ponytail-instructions.js')
const {
  RUNTIME_MODES,
  getConfigDir,
  getDefaultMode,
  isDeactivationCommand,
  normalizeMode,
  writeDefaultMode,
} = require('./hooks/ponytail-config.js')

const here = path.dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = path.join(here, 'skills')

export const name = 'ponytail'
export const inject = ['systemPrompt', 'skills']

// Declared before Config: the disabledSkills enum is built from ONE_SHOT_SKILLS.
const SKILL_NAMES = ['ponytail', 'ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help']
const ONE_SHOT_SKILLS = ['ponytail-review', 'ponytail-audit', 'ponytail-debt', 'ponytail-gain', 'ponytail-help']

// `defaultMode: 'inherit'` keeps the upstream chain (PONYTAIL_DEFAULT_MODE env var,
// then the upstream global config file, then 'full'). Anything else must be a
// runtime level; an invalid value fails loudly at plugin load.
// Every field is .volatile(): the Loader commits live references on
// `loader/volatile-update` instead of remounting the plugin, so the native settings
// panel can change these without losing in-memory session overrides. Keep the enum
// explicit (the community adapter uses z.any() here; an invalid value must fail loudly).
export const Config = z.object({
  defaultMode: z.union([z.const('inherit'), ...RUNTIME_MODES.map(mode => z.const(mode))]).default('inherit').volatile()
    .description('Session default intensity for this profile. "inherit" follows PONYTAIL_DEFAULT_MODE, then the upstream ponytail config file, then "full".'),
  // Opt-OUT list (matches the community settings contract): names present here are
  // removed from ctx.skills AND their one-shot commands. Only the five optional
  // skills can be named — `ponytail` itself is always registered.
  disabledSkills: z.array(z.union(ONE_SHOT_SKILLS.map(skill => z.const(skill)))).default([]).volatile()
    .description('Optional skills to keep out of this profile: ponytail-review, ponytail-audit, ponytail-debt, ponytail-gain, ponytail-help. The core ruleset, the ponytail skill and /ponytail are never removed.'),
  showBand: z.boolean().default(true).volatile()
    .description('Show the native status band that reports the active Ponytail level for this session.'),
  expandedBand: z.boolean().default(false).volatile()
    .description('Render the native status band in its expanded form, with the effective default and where it comes from.'),
})

/**
 * Cross-copy volatile reference protocol (cosmokit): a modern Loader hands config
 * fields to plugins as stable references whose value changes in place. Plain values
 * (headless mounts, older hosts) pass straight through.
 */
function configValue(value) {
  return value && typeof value === 'object' && Symbol.for('cosmokit.volatile.write') in value ? value.get() : value
}

// Prompt-section placement: after the deployment persona (0) and before first-party
// tool guidance (TOOL_BASH = 1000). Matches @mengyuly/dsh-ponytail's slot so a
// profile that swaps this package in keeps its prompt ordering.
const SECTION_ORDER = 40

const MODE_HINT = `[${[...RUNTIME_MODES, 'help|status|reset|default <mode>'].join('|')}]`
const COMMAND_HELP =
  `Ponytail (dsh adapter): /ponytail lite|full|ultra|off switches this session; ` +
  `/ponytail status shows this profile's effective default and where it comes from; /ponytail reset drops this session's override; ` +
  `/ponytail default <mode> saves the upstream global default (${defaultFileHint()}), which a profile config.defaultMode can still override. ` +
  'One-shots: /ponytail-review, /ponytail-audit, /ponytail-debt, /ponytail-gain, /ponytail-help. ' +
  "Deactivate with 'stop ponytail' or 'normal mode'. Session overrides reset when the process restarts."

function defaultFileHint() {
  // Upstream getConfigPath(): $XDG_CONFIG_HOME/ponytail/config.json, else
  // %APPDATA%\ponytail\config.json on Windows, else ~/.config/ponytail/config.json.
  return path.join(getConfigDir(), 'config.json')
}

/** Stable per-agent key for session-scoped overrides (same idiom as the reference adapter). */
function sessionKey(agent) {
  return agent?.session?.id ?? agent?.id ?? null
}

/** In-memory, per-session mode overrides. No disk state per agent. */
class ModeStore {
  constructor() {
    this.overrides = new Map()
  }
  set(key, mode) {
    if (key === null) return
    this.overrides.set(key, mode)
  }
  clear(key) {
    this.overrides.delete(key)
  }
  modeFor(key, fallback) {
    return this.overrides.get(key) ?? fallback
  }
}

/**
 * Parse one `/ponytail` argument line. Mirrors upstream pi-extension semantics:
 * bare switches on (or reports status when already active), `status`, `reset`,
 * `default <runtime-mode>`, and a bare runtime level. Anything else is invalid
 * and must leave session state untouched.
 */
function parsePonytailInput(input, currentMode) {
  const text = String(input ?? '').trim().toLowerCase()
  if (!text) {
    // Bare /ponytail: keep an active mode (report it), or re-enable from off.
    if (currentMode && currentMode !== 'off') return { type: 'status' }
    return { type: 'set-mode', mode: 'resume' }
  }
  const [head, ...rest] = text.split(/\s+/)
  if (head === 'status') return rest.length ? { type: 'invalid', reason: 'status takes no arguments' } : { type: 'status' }
  if (head === 'reset') return rest.length ? { type: 'invalid', reason: 'reset takes no arguments' } : { type: 'reset' }
  if (head === 'help') return rest.length ? { type: 'invalid', reason: 'help takes no arguments' } : { type: 'help' }
  if (head === 'default') {
    if (rest.length !== 1) return { type: 'invalid', reason: 'usage: /ponytail default [lite|full|ultra|off]' }
    const mode = normalizeMode(rest[0])
    return mode ? { type: 'set-default', mode } : { type: 'invalid', reason: `"${rest[0]}" is not a runtime level (off|lite|full|ultra)` }
  }
  if (head === 'review') return { type: 'invalid', reason: 'review is a one-shot skill: use /ponytail-review' }
  const mode = normalizeMode(head)
  if (!mode) return { type: 'invalid', reason: `unknown argument "${text}". ${COMMAND_HELP}` }
  if (rest.length) return { type: 'invalid', reason: `"${head}" takes no further arguments` }
  return { type: 'set-mode', mode }
}

/** Load one upstream SKILL.md and translate its frontmatter into a SkillRegistration. */
function loadSkill(name) {
  const file = path.join(SKILLS_DIR, name, 'SKILL.md')
  const raw = fs.readFileSync(file, 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)
  if (!match) throw new Error(`ponytail skill "${name}": SKILL.md has no YAML frontmatter`)
  // Tiny scalar-list frontmatter reader: the six upstream skills use only
  // `key: value` and `key: >` folded scalars. A real YAML dependency for this is
  // exactly what Ponytail itself would reject. shortcut: scalars/folded blocks
  // only, upgrade to a YAML parser if a skill gains nested frontmatter.
  const fields = {}
  let key = null
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (pair) {
      key = pair[1]
      fields[key] = pair[2].trim() === '>' || pair[2].trim() === '|' ? '' : pair[2].trim()
    } else if (key !== null && /^\s+\S/.test(line)) {
      fields[key] = (fields[key] ? fields[key] + ' ' : '') + line.trim()
    }
  }
  const body = raw.slice(match[0].length)
  return {
    name: fields.name || name,
    description: fields.description,
    content: body,
    source: 'bundled',
    path: file,
    // ponytail-gain references `benchmarks/results/...`, which is vendored at the
    // package root — so its resource base is the package root, not its own skill
    // directory. Every other skill keeps its own directory as the resource base.
    resourceBase: { kind: 'directory', path: name === 'ponytail-gain' ? here : path.dirname(file) },
  }
}

export function apply(ctx, config = {}) {
  // Config fields may be volatile references (modern Loader) or plain values (headless,
  // older hosts). Every read below goes through configValue() so a live settings write
  // takes effect without remounting — the community adapter's pattern.
  const configuredDefaultMode = () => {
    const value = configValue(config.defaultMode) ?? 'inherit'
    if (value === 'inherit') return 'inherit'
    const normalized = normalizeMode(value)
    if (normalized === null) {
      ctx.logger.warn(`[ponytail] profile config defaultMode is not inherit|off|lite|full|ultra: ${JSON.stringify(value)}; falling back to inherit`)
      return 'inherit'
    }
    return normalized
  }
  const disabledSet = () => {
    const raw = configValue(config.disabledSkills)
    return new Set((Array.isArray(raw) ? raw : []).filter(skill => ONE_SHOT_SKILLS.includes(skill)))
  }
  // Upstream resolution chain (env var → global config file → 'full') for the
  // "configured default" that bare /ponytail and a fresh session fall back to.
  const upstreamDefault = () => {
    const configured = configuredDefaultMode()
    return configured === 'inherit' ? getDefaultMode() : configured
  }

  const store = new ModeStore()
  // Live-process last recorded test command, keyed exactly like ModeStore session
  // keys. In-memory only: no disk file, no new RPC writes, no custom session events,
  // and nothing durable — a restart loses it (the UI labels that explicitly).
  const lastTests = new Map()
  ctx.on('agent/disposed', ({ agent }) => {
    store.clear(sessionKey(agent))
    lastTests.delete(sessionKey(agent))
  })
  // Verified host contract (dsh-tools lib/index.js notifyResult ~3503): the event
  // carries (exec, result) with exec = { agent, name, arguments, … } and the
  // canonical result DTO. recordedTestResult is pure and rejects everything that is
  // not a simple foreground test command; only its matched-runner record is stored.
  ctx.on('tools/result', (exec, result) => {
    const key = sessionKey(exec?.agent)
    if (key === null) return
    const record = recordedTestResult(exec, result)
    if (record !== null) lastTests.set(key, record)
  })

  // The always-on ruleset. Dynamic per assembly: the calling agent's session
  // override wins, else the configured default. `off` returns an empty string,
  // which renderPrompt drops — the upstream builder alone does not do this for
  // 'off', so the adapter handles it explicitly. Other sections are untouched.
  // Host contract caveat: if another contributor registers a `complete: true`
  // section, dsh-system-prompt makes that section the ENTIRE prompt and this
  // one is suppressed — the adapter does not (and must not) override that.
  ctx.systemPrompt.section({
    name: 'ponytail',
    order: SECTION_ORDER,
    text: (context) => {
      const mode = store.modeFor(sessionKey(context?.scope), upstreamDefault())
      if (mode === 'off') return ''
      return getPonytailInstructions(mode)
    },
  })

  // Skill registration is unconditional and lives in THIS fiber — never inside the
  // commands dependency. `refreshOptional` below adds/removes only the optional rows,
  // so a live settings write never re-registers the core ruleset skill.
  const registeredSkills = new Map()

  /** Register one optional skill unless config.disabledSkills names it; track it for removal. */
  function registerSkill(skillName) {
    if (registeredSkills.has(skillName)) return
    if (skillName !== 'ponytail' && disabledSet().has(skillName)) return
    registeredSkills.set(skillName, ctx.skills.register(loadSkill(skillName)))
  }

  /** Drop exactly one skill registration, leaving every other row untouched. */
  function disposeSkill(skillName) {
    const dispose = registeredSkills.get(skillName)
    if (!dispose) return
    registeredSkills.delete(skillName)
    if (typeof dispose === 'function') dispose()
  }

  /**
   * The original one-shot command definition, verbatim from the baseline handler.
   * A closure inside apply() so it keeps `ctx` (for ctx.skills.get) without the
   * definition itself depending on the commands service.
   */
  function oneShotDefinition(skillName) {
    return {
      name: skillName,
      description: `Run the ${skillName} one-shot skill`,
      // attachments: true matches the host contract (dsh-commands enforces a
      // BOOLEAN flag here, and admits submitted attachments into ImageBlock/
      // FileBlock before the handler runs). Admitted attachments ride along
      // in the user message — never silently dropped. Without an attachment
      // store composed, the executor settles as an error, also no silent loss.
      input: { hint: '[notes]', attachments: true },
      handler: async ({ agent, rawInput, attachments, signal }) => {
        // One-shots never change the active mode. They render the canonical
        // <skill_content> and wake the driver with a follow-up (inject alone
        // does not wake an idle agent). A disabled skill's command is normally
        // gone too; if only one half got removed, `skills.get` answers undefined
        // and this reports it instead of failing silently.
        const loaded = await ctx.skills.get(skillName, {
          cwd: agent?.session?.header?.cwd,
          signal,
        })
        if (loaded === undefined) return { kind: 'error', text: `skill "${skillName}" is not available` }
        const notes = String(rawInput ?? '').trim()
        // Canonical <skill_content> first (the harness renderer, verbatim), then
        // the user's own message with their notes and any admitted attachments.
        const blocks = [{ type: 'text', text: renderSkillContent(loaded) }]
        if (notes !== '') blocks.push({ type: 'text', text: notes })
        for (const attachment of attachments ?? []) {
          if (attachment?.type === 'image' || attachment?.type === 'file') blocks.push(attachment)
        }
        agent.followup(createUserMessage({
          content: blocks,
          source: { kind: 'skill-invocation', name: skillName, form: 'instructions' },
        }))
        return { kind: 'success', text: `Queued ${skillName} for the agent.` }
      },
    }
  }

  // The commands child is composed once. `commandContext` is just the handle on it so
  // refreshOptional can add/remove one-shot rows through the SAME registry the child
  // registered /ponytail on — no child churn, no service probes, no async juggling.
  let commandContext = null
  // Independent from the skill map above: a command row and a skill registration are
  // separate host registrations with separate disposers.
  const optionalCommandDisposers = new Map()

  /** Reconcile optional skills and one-shot command rows with config.disabledSkills. */
  function refreshOptional() {
    const disabled = disabledSet()
    // The core `ponytail` skill is registered once, unconditionally, above — never
    // reconciled here, so it can never be registered twice or dropped. Only the five
    // optional skills are in play; the always-on ruleset section and the /ponytail
    // mode command are never removable.
    for (const skillName of ONE_SHOT_SKILLS) {
      const enabled = !disabled.has(skillName)
      if (enabled && !registeredSkills.has(skillName)) {
        registeredSkills.set(skillName, ctx.skills.register(loadSkill(skillName)))
      } else if (!enabled) {
        disposeSkill(skillName)
      }
      if (!commandContext) continue
      if (enabled && !optionalCommandDisposers.has(skillName)) {
        // Verified host contract: dsh-commands register() returns the exact Cordis
        // effect disposer for this definition, so removing one row never touches
        // /ponytail or another row. The fallback covers a host that hands back void.
        const disposeCommand = commandContext.commands.register(oneShotDefinition(skillName))
        if (typeof disposeCommand === 'function') optionalCommandDisposers.set(skillName, disposeCommand)
      } else if (!enabled) {
        const disposeCommand = optionalCommandDisposers.get(skillName)
        if (disposeCommand) {
          optionalCommandDisposers.delete(skillName)
          disposeCommand()
        }
      }
    }
  }

  // Core skill first, unconditionally, outside the commands injection.
  registerSkill('ponytail')

  ctx.inject(['commands'], (commandCtx) => {
    commandContext = commandCtx
    const effectiveMode = (agent) => store.modeFor(sessionKey(agent), upstreamDefault())

    // The main /ponytail mode command: registered once, never re-registered, so a
    // settings change can never drop it.
    commandCtx.commands.register({
      name: 'ponytail',
      description: 'Set or show Ponytail lazy senior dev intensity (lite/full/ultra/off)',
      input: { hint: MODE_HINT },
      handler: ({ agent, rawInput }) => {
        const parsed = parsePonytailInput(rawInput, effectiveMode(agent))
        switch (parsed.type) {
          case 'help':
            return { kind: 'success', text: COMMAND_HELP }
          case 'status': {
            // Report THIS profile's effective default — a config.defaultMode
            // override wins over the upstream global file, which is what
            // getDefaultMode() alone would wrongly claim.
            const mode = effectiveMode(agent)
            const override = store.modeFor(sessionKey(agent), null)
            const configured = configuredDefaultMode()
            let source
            if (override) source = 'session override'
            else if (configured !== 'inherit') source = `profile config.defaultMode (${configured})`
            else source = 'default: PONYTAIL_DEFAULT_MODE / ponytail config file / full'
            return { kind: 'success', text: `Ponytail: ${mode} — ${source}. Overrides last for this process only.` }
          }
          case 'reset': {
            store.clear(sessionKey(agent))
            const mode = upstreamDefault()
            agent.inject(createUserMessage({
              content: [{ type: 'text', text: mode === 'off' ? 'PONYTAIL MODE OFF' : `PONYTAIL MODE CHANGED — level: ${mode}` }],
              source: { kind: 'ponytail' },
            }))
            return { kind: 'success', text: `Session override cleared; ponytail is ${mode}.` }
          }
          case 'set-default': {
            try {
              const written = writeDefaultMode(parsed.mode)
              if (!written) return { kind: 'error', text: `Failed to save default: "${parsed.mode}" is not a runtime level.` }
              const effective = getDefaultMode()
              let note
              if (effective !== written) {
                note = `Saved ${written}, but PONYTAIL_DEFAULT_MODE keeps the effective upstream default at ${effective}.`
              } else if (configuredDefaultMode() !== 'inherit' && configuredDefaultMode() !== written) {
                note = `Saved global ponytail default: ${written}. This profile's config.defaultMode (${configuredDefaultMode()}) still overrides it — /ponytail status shows what is actually in effect.`
              } else {
                note = `Saved global ponytail default: ${written}.`
              }
              return { kind: 'success', text: note }
            } catch (error) {
              return { kind: 'error', text: `Failed to save default: ${error.message}` }
            }
          }
          case 'set-mode': {
            // Bare invocation re-enables at the configured default; "off" stays off
            // until an explicit level arrives.
            const mode = parsed.mode === 'resume' ? (upstreamDefault() === 'off' ? 'full' : upstreamDefault()) : parsed.mode
            store.set(sessionKey(agent), mode)
            agent.inject(createUserMessage({
              content: [{ type: 'text', text: mode === 'off' ? 'PONYTAIL MODE OFF' : `PONYTAIL MODE CHANGED — level: ${mode}` }],
              source: { kind: 'ponytail' },
            }))
            return { kind: 'success', text: `Ponytail mode set to ${mode} for this session.` }
          }
          default:
            // Invalid input: state untouched, no model-visible notice.
            return { kind: 'error', text: parsed.reason }
        }
      },
    })

    refreshOptional()

    // The child is going away (plugin unload or host teardown): forget the handle and
    // the per-row command disposers — the host's own effects already removed those
    // actual registrations. Stored disposers are idempotent, so a later double call is safe.
    commandCtx.effect(() => () => {
      commandContext = null
      optionalCommandDisposers.clear()
    }, 'ponytail: commands child teardown')
  })

  // Headless mounts (no command registry composed) still get every enabled skill, and
  // a mount whose registry appears later gets its rows from the inject above.
  refreshOptional()

  // Optional host settings service (dsh-settings). Present in the desktop/web host,
  // absent headless — an optional inject never acquires a new required service there.
  // Defaults persistence is HOST owned (profile config store); this adapter adds no
  // file-backed settings of its own. `configure({ auto: false })` tells the host the
  // native Plugins tab (client.js) replaces its auto-generated form for this namespace.
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    if (!settings || typeof settings.configure !== 'function') return
    settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber), 'ponytail settings')
  })

  // Live config updates: the Loader commits volatile references before this event and
  // does NOT remount the plugin, so ModeStore session overrides survive a settings save.
  ctx.on('loader/volatile-update', () => refreshOptional())

  // Optional projection seam: register the ponytailStats fold only where the host
  // composed `sessionProjections`. An optional inject never acquires a new required
  // service, so headless mounts (and this package's own tests) are unaffected.
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(ponytailStatsProjectionDefinition)
  })

  // Read-only effective-state route for the approved native UI, registered inside
  // THIS apply closure so it reads the actual ModeStore and the current volatile
  // config through the same closures (`store`, `upstreamDefault`, `configuredDefaultMode`,
  // `disabledSet`, `configValue`) — no duplicated state, no guessed identifiers.
  // Exact Fetch routes are already owner-authorized by the host for desktop/browser;
  // this adds NO new HTTP server and performs NO writes of any kind.
  // Host contract (verified in @deepseek-ai/dsh-client-connection HostConnectionService
  // .registerFetchRoute): `fetch.register` runs the registration on THIS child's fiber
  // and returns the already-owned Cordis effect disposer. Calling that disposer here as
  // an "effect initializer" would unregister the route immediately, so there is no outer
  // ctx.effect wrapper and the return value is deliberately not captured — the host
  // tracks the route's lifetime (plugin unload / lost connection service) itself.
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.connection.fetch.register({
      path: PONYTAIL_STATE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          return Response.json({ error: 'body is not JSON' }, { status: 400, headers: { 'cache-control': 'no-store' } })
        }
        const parsed = parsePonytailStateRequest(body)
        if (!parsed.ok) {
          // Fixed message only — arbitrary client input is never reflected back.
          return Response.json({ error: parsed.message }, { status: 400, headers: { 'cache-control': 'no-store' } })
        }
        const sessionId = parsed.body.sessionId
        const defaultMode = upstreamDefault()
        return Response.json({
          type: 'server-response',
          rpcId: parsed.body.rpcId,
          result: {
            ok: true,
            value: {
              mode: store.modeFor(sessionId, defaultMode),
              defaultMode,
              source: store.modeFor(sessionId, null) ? 'Session override' : configuredDefaultMode() === 'inherit' ? 'Upstream default' : 'Profile default',
              showBand: configValue(config.showBand) ?? true,
              expandedBand: configValue(config.expandedBand) ?? false,
              disabledSkills: [...disabledSet()],
              // Live-process evidence for this session only; null until the first
              // valid simple foreground test command settles in THIS process.
              lastTest: lastTests.get(sessionId) ?? null,
            },
          },
        }, { headers: { 'cache-control': 'no-store' } })
      },
    })
  })

  // Plain-text deactivation: ONLY a genuine human user message — role 'user' AND
  // source.kind 'user' (dsh-llm types/message.d.ts MessageSourceMap.user) — whose
  // whole text normalizes to "stop ponytail" / "normal mode" (upstream
  // isDeactivationCommand). Plugin notices, skill-invocation content, injected
  // instructions, assistant and tool text are never scanned. Runs in agent/pre-step,
  // before the step's request derives; `next()` exactly once.
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const deactivated = Array.isArray(messages) && messages.some(message => isDeactivationCommand(humanUserText(message)))
    if (deactivated) store.set(sessionKey(agent), 'off')
    const decision = await next()
    if (deactivated && decision?.kind === 'enter') {
      return {
        ...decision,
        messages: [
          ...(decision.messages ?? []),
          createUserMessage({
            content: [{ type: 'text', text: 'PONYTAIL MODE OFF' }],
            source: { kind: 'ponytail' },
          }),
        ],
      }
    }
    return decision
  })
}

/** Extract the plain text of one message (only its text blocks). Internal. */
function messageText(message) {
  const parts = []
  for (const block of message?.content ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** Plain text of a genuine human user message ('' for anything else). */
function humanUserText(message) {
  if (message?.role !== 'user' || message?.source?.kind !== 'user') return ''
  return messageText(message)
}
