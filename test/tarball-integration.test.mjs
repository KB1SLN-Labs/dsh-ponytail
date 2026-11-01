// Tarball integration proof for @kb1slnlabs/dsh-ponytail — NOT part of the npm
// tarball (package.json `files` omits test/ except what is listed there).
//
// It runs the REAL Cordis Loader against the ACTUAL packaged artifact:
//   1. spawn the npm CLI via process.execPath + its cli.js (never execFileSync
//      of a shell shim — Windows EINVAL), `npm pack` into a scratch dir;
//   2. unpack the .tgz under work/<unique-profile>/node_modules/@kb1slnlabs/
//      dsh-ponytail (standard install layout, no junction inside the package);
//   3. link required host peers as SIBLINGS in that scratch node_modules;
//   4. headless mount: Loader entry, prompt section + skills, NO command registry;
//   5. interactive smoke: compose CommandRuntime and run /ponytail status,
//      /ponytail ultra, a one-shot (rendered <skill_content>, no [object Promise]),
//      then dispose the created entry and plugin contexts.
// No model calls, no network. The agent remains a stub; this proves packaging,
// peer resolution, and mount wiring — not live agent behaviour.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')

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
const u = (p) => pathToFileURL(path.join(hostModules, p)).href

// Unique scratch profile under the explicit test work root, never a live profile.
const testWork = process.env.PONYTAIL_TEST_WORK || path.join(os.tmpdir(), 'dsh-ponytail-tests')
fs.mkdirSync(testWork, { recursive: true })
const workRoot = fs.realpathSync(testWork)
const profileDir = fs.mkdtempSync(path.join(workRoot, 'ponytail-tarball-profile-'))
if (!fs.realpathSync(profileDir).startsWith(workRoot + path.sep)) throw new Error('scratch profile escaped work/')

// Isolated upstream-config env for the whole check.
process.env.XDG_CONFIG_HOME = path.join(profileDir, 'xdg')
delete process.env.PONYTAIL_DEFAULT_MODE

try {
  // 1. Pack with the npm CLI through node itself (no shell shim → no EINVAL).
  // Prefer the npm entry that invoked us (process.env.npm_execpath), else the
  // npm bundled next to this node binary.
  const npmCli = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!fs.existsSync(npmCli)) throw new Error(`cannot locate npm-cli.js (npm_execpath=${process.env.npm_execpath}, looked next to ${process.execPath})`)
  execFileSync(process.execPath, [npmCli, 'pack', '--pack-destination', profileDir], { cwd: pkgDir, stdio: 'pipe' })
  const tarball = fs.readdirSync(profileDir).find(f => f.endsWith('.tgz'))
  assert.ok(tarball, 'npm pack produced a tarball')

  // 2. Unpack into the scratch profile's node_modules at the real package path,
  //    with the standard platform tar (already used successfully in this repo).
  const tarballPath = path.join(profileDir, tarball)
  const target = path.join(profileDir, 'node_modules', '@kb1slnlabs', 'dsh-ponytail')
  fs.mkdirSync(target, { recursive: true })
  execFileSync(process.platform === 'win32' ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : 'tar', ['-xzf', tarballPath, '--strip-components=1', '-C', target], { stdio: 'pipe' })

  // The tarball must contain the runtime surface AND no stray node_modules.
  for (const required of ['index.js', 'metrics.js', 'client.js', 'hooks/ponytail-instructions.js', 'hooks/ponytail-config.js', 'cordis.patch.yml', 'benchmarks/results/2026-10-07-agentic.md']) {
    assert.ok(fs.existsSync(path.join(target, required)), `tarball ships ${required}`)
  }
  assert.ok(!fs.existsSync(path.join(target, 'node_modules')), 'no stray node_modules in the package')

  // 3. Host peers as siblings — standard install layout; bare specifiers in
  //    index.js resolve through this chain exactly like a pnpm profile.
  fs.mkdirSync(path.join(profileDir, 'node_modules', '@deepseek-ai'), { recursive: true })
  for (const pkg of ['cordis', 'dsh-system-prompt', 'dsh-skill', 'dsh-llm', 'dsh-commands', 'schemastery']) {
    fs.symlinkSync(path.join(hostModules, '@deepseek-ai', pkg), path.join(profileDir, 'node_modules', '@deepseek-ai', pkg), 'junction')
  }
  // zod is the host-declared OPTIONAL peer that metrics.js imports — it lives at
  // the node_modules root of the host tree, so link it as a sibling too.
  fs.symlinkSync(path.join(hostModules, 'zod'), path.join(profileDir, 'node_modules', 'zod'), 'junction')

  const { Context } = await import(u('@deepseek-ai/cordis/lib/index.js'))
  const Loader = (await import(u('@deepseek-ai/cordis-plugin-loader/lib/index.js'))).default
  const SystemPrompt = (await import(u('@deepseek-ai/dsh-system-prompt/lib/index.js'))).default
  const SkillRegistry = (await import(u('@deepseek-ai/dsh-skill/lib/index.js'))).default
  const CommandRuntime = (await import(u('@deepseek-ai/dsh-commands/lib/index.js'))).default

  // 4. Headless mount through the REAL Loader: bare-name entry, no commands service.
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(profileDir).href + '/'
  new SystemPrompt(ctx, {})
  new SkillRegistry(ctx)
  await ctx.plugin(Loader)
  const entryId = await ctx.loader.create({ id: 'ponytail', name: '@kb1slnlabs/dsh-ponytail', config: { defaultMode: 'ultra' } })
  const entry = ctx.get('loader').resolve(entryId)
  assert.ok(entry.fiber, 'tarball plugin mounted through the real Cordis Loader (no default-export collapse)')

  const scope = { id: 'agent-tar', session: { id: 'agent-tar', header: { cwd: profileDir } } }
  const assembly = await ctx.get('systemPrompt').assemble({ scope })
  const section = assembly.sections.find(s => s.name === 'ponytail')
  assert.ok(section, 'ponytail section present from the tarball mount')
  assert.match(section.text, /PONYTAIL MODE ACTIVE — level: ultra/)
  assert.equal((await ctx.get('skills').list({})).length, 6, 'six skills registered from packaged SKILL.md files')
  const gain = await ctx.get('skills').get('ponytail-gain', {})
  assert.ok(fs.existsSync(path.join(gain.resourceBase.path, 'benchmarks', 'results', '2026-10-07-agentic.md')), 'vendored benchmark reachable from the packaged skill resource base')

  // 5. Interactive smoke: compose commands and drive them through the registry.
  const commands = new CommandRuntime(ctx)
  await new Promise(resolve => setImmediate(resolve))
  const injected = []
  const followups = []
  const agent = {
    id: 'agent-tar',
    session: { id: 'agent-tar', header: { cwd: profileDir }, append: () => Promise.resolve({ seq: 1 }) },
    inject: (m) => injected.push(m),
    followup: (m) => followups.push(m),
  }
  const status = await commands.execute(agent, '/ponytail status', [], new AbortController().signal)
  assert.equal(status.result.kind, 'success')
  assert.match(status.result.text, /Ponytail: ultra — profile config\.defaultMode \(ultra\)/)
  const setLite = await commands.execute(agent, '/ponytail lite', [], new AbortController().signal)
  assert.equal(setLite.result.kind, 'success')
  const after = await ctx.get('systemPrompt').assemble({ scope })
  assert.match(after.sections.find(s => s.name === 'ponytail').text, /level: lite/)
  const oneShot = await commands.execute(agent, '/ponytail-help show me', [], new AbortController().signal)
  assert.equal(oneShot.result.kind, 'success')
  const queued = followups[0].content.map(b => b.text ?? '').join('\n')
  assert.match(queued, /<skill_content name="ponytail-help">/)
  assert.doesNotMatch(queued, /\[object Promise\]/)

  // Disposal: the created entry and every service context unwind cleanly.
  await ctx.loader.remove(entryId)
  const afterDispose = await ctx.get('systemPrompt').assemble({ scope })
  assert.ok(!afterDispose.sections.some(s => s.name === 'ponytail'), 'entry disposal removed the ponytail section')
  assert.deepEqual(await ctx.get('skills').list({}), [], 'entry disposal removed the skills')

  console.log(`PASS tarball integration: packed by npm CLI via process.execPath, unpacked at node_modules/@kb1slnlabs/dsh-ponytail in ${path.basename(profileDir)}, peers as siblings, real Loader mount (headless section+skills), interactive status/set/one-shot smoke, disposal clean. No model calls.`)
} finally {
  // Remove the scratch profile: unlink our junctions first so nothing can
  // recurse into host modules, then remove plain files/dirs we created.
  for (const pkg of ['cordis', 'dsh-system-prompt', 'dsh-skill', 'dsh-llm', 'dsh-commands', 'schemastery']) {
    try { fs.unlinkSync(path.join(profileDir, 'node_modules', '@deepseek-ai', pkg)) } catch {}
  }
  try { fs.unlinkSync(path.join(profileDir, 'node_modules', 'zod')) } catch {}
  fs.rmSync(profileDir, { recursive: true, force: true })
}
