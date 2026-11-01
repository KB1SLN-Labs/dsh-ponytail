// Prove the real host evaluator accepts the published peer range on supported dsh runtimes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const hostModules = path.join(process.env.DSH_ROOT ?? '', 'node_modules')
if (!process.env.DSH_ROOT || !fs.existsSync(hostModules)) throw new Error(`DSH_ROOT must point at the @deepseek-ai/dsh package directory with node_modules: ${process.env.DSH_ROOT}`)

const appBootPath = path.join(hostModules, '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')
if (!fs.existsSync(appBootPath)) throw new Error(`host dsh-app-boot module not found at ${appBootPath}`)
const { evaluatePluginCompatibility } = await import(pathToFileURL(appBootPath).href)

const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
const RANGE = '>=0.2.1-rc.3 <0.3.0'
const PEERS = ['@deepseek-ai/dsh-commands', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-skill', '@deepseek-ai/dsh-system-prompt']

test('root manifest keeps the supported peer range', () => {
  for (const name of PEERS) assert.equal(manifest.peerDependencies[name], RANGE, `${name} must stay on the supported range`)
})

for (const version of ['0.2.1-rc.3', '0.2.1-rc.5', '0.2.1-rc.6', '0.2.2-alpha.2']) {
  test(`host accepts dsh ${version}`, () => {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined)
  })
}

for (const version of ['0.2.1-rc.2', '0.3.0']) {
  test(`host reports an issue for dsh ${version}`, () => {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    assert.ok(issue, `${version} is outside ${RANGE}`)
    assert.equal(issue.runtimeVersion, version)
    assert.deepEqual(Object.keys(issue.requirements).sort(), [...PEERS].sort())
    for (const name of PEERS) assert.equal(issue.requirements[name], RANGE)
  })
}
