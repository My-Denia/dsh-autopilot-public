import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const at = (...parts) => join(root, ...parts)
const read = (...parts) => readFileSync(at(...parts), 'utf8')

const PRESETS = ['goal-executor-lead', 'goal-planner', 'goal-reviewer', 'goal-scout', 'goal-worker']
const LEAF_PRESETS = ['goal-planner', 'goal-scout', 'goal-worker']

// `!!js` is a Loader expression tag, not data. `yaml` does not know that tag, so
// this suite registers it as a plain string: the assertions are about the
// structure the Loader reads, not about evaluating the platform guards.
const LOADER_JS = { tag: 'tag:yaml.org,2002:js', resolve: (value) => String(value ?? '') }

function patchRows() {
  const doc = parseDocument(read('cordis.patch.yml'), { customTags: [LOADER_JS] })
  assert.deepEqual(doc.errors, [], 'cordis.patch.yml must parse')
  const layers = doc.toJS()
  assert.ok(Array.isArray(layers) && layers.length === 1, 'the patch is one layer list')
  const [layer] = layers
  assert.ok(Array.isArray(layer.insert), 'the layer inserts rows')
  return layer.insert
}

function presetRows() {
  return patchRows().filter((row) => row.name === '@deepseek-ai/dsh-agent-preset')
}

test('the bundle patch parses and inserts exactly six rows', () => {
  const rows = patchRows()
  assert.equal(rows.length, 6)
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    ['delegate', 'preset-goal-executor-lead', 'preset-goal-planner', 'preset-goal-reviewer', 'preset-goal-scout', 'preset-goal-worker'],
  )
})

test('every inserted Loader id is unique', () => {
  const ids = patchRows().map((row) => row.id)
  assert.equal(new Set(ids).size, ids.length, `duplicate inserted ids: ${ids.join(', ')}`)
})

test('the delegate row is a depth-1 spawn tool for exactly the five presets', () => {
  const delegate = patchRows().find((row) => row.id === 'delegate')
  assert.ok(delegate, 'a profile-level delegate row is inserted')
  assert.equal(delegate.name, '@deepseek-ai/dsh-tool-subagent')
  const { config } = delegate
  assert.equal(config.provider, 'spawn')
  assert.equal(config.toolName, 'delegate')
  assert.equal(config.modelSelection, true)
  assert.equal(config.modelDiscovery, true)
  assert.equal(config.maxDepth, 1)
  assert.deepEqual([...config.allowedAgentPresets].sort(), PRESETS)
})

test('the patch declares the five presets with those config ids', () => {
  const ids = presetRows().map((row) => row.config.id)
  assert.deepEqual([...ids].sort(), PRESETS)
  assert.equal(new Set(ids).size, ids.length)
  // Every id the delegate row can select is a declared preset.
  const declared = new Set(ids)
  for (const choice of patchRows().find((row) => row.id === 'delegate').config.allowedAgentPresets) {
    assert.ok(declared.has(choice), `delegate offers ${choice} but no preset declares it`)
  }
})

test('every preset composes a persona, a time context and at least one tool package', () => {
  for (const row of presetRows()) {
    const id = row.config.id
    const plugins = row.config.plugins
    assert.ok(Array.isArray(plugins) && plugins.length > 0, `${id} has a plugin list`)

    const persona = plugins.find((plugin) => plugin.name === '@deepseek-ai/dsh-persona')
    assert.ok(persona, `${id} composes a persona`)
    assert.equal(typeof persona.config?.prefix, 'string', `${id} persona has a prefix`)
    assert.ok(persona.config.prefix.trim().length > 0, `${id} persona prefix is not empty`)

    assert.ok(
      plugins.some((plugin) => plugin.name === '@deepseek-ai/dsh-time-context'),
      `${id} composes the time context`,
    )
    assert.ok(
      plugins.some((plugin) => typeof plugin.name === 'string' && plugin.name.startsWith('@deepseek-ai/dsh-tool-')),
      `${id} composes at least one tool package`,
    )
  }
})

test('the executor lead has its own delegate row at depth 2 with only the three leaves', () => {
  const lead = presetRows().find((row) => row.config.id === 'goal-executor-lead')
  assert.ok(lead, 'goal-executor-lead is declared')
  const delegates = lead.config.plugins.filter((plugin) => plugin.name === '@deepseek-ai/dsh-tool-subagent')
  assert.equal(delegates.length, 1, 'the lead mounts exactly one delegation row')

  const row = delegates[0]
  assert.equal(row.config.toolName, 'delegate')
  assert.equal(row.config.maxDepth, 2)
  assert.deepEqual([...row.config.allowedAgentPresets].sort(), LEAF_PRESETS)
  assert.ok(!row.config.allowedAgentPresets.includes('goal-executor-lead'), 'the lead cannot nest itself')
  assert.ok(!row.config.allowedAgentPresets.includes('goal-reviewer'), 'the reviewer is the root call')
})

test('read-only presets cannot write; worker and lead can', () => {
  const byId = new Map(presetRows().map((row) => [row.config.id, row]))

  for (const id of ['goal-scout', 'goal-planner', 'goal-reviewer']) {
    const plugins = byId.get(id).config.plugins
    assert.ok(!plugins.some((plugin) => plugin.name === '@deepseek-ai/dsh-tool-bash'), `${id} has no shell`)
    const fsRow = plugins.find((plugin) => plugin.name === '@deepseek-ai/dsh-tool-fs')
    assert.ok(fsRow, `${id} composes tool-fs`)
    assert.equal(fsRow.config.read, true)
    assert.equal(fsRow.config.readImage, true)
    assert.equal(fsRow.config.write, false)
    assert.equal(fsRow.config.edit, false)
    assert.ok(!plugins.some((plugin) => plugin.name === '@deepseek-ai/dsh-tool-subagent'), `${id} cannot delegate`)
  }

  for (const id of ['goal-worker', 'goal-executor-lead']) {
    const names = byId.get(id).config.plugins.map((plugin) => plugin.name)
    for (const expected of [
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-pwsh',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-fs-search',
      '@deepseek-ai/dsh-tool-jobs',
    ]) {
      assert.ok(names.includes(expected), `${id} composes ${expected}`)
    }
  }

  const lead = byId.get('goal-executor-lead').config.plugins.map((plugin) => plugin.name)
  assert.ok(lead.includes('@deepseek-ai/dsh-tool-subagent-control'), 'the lead can list and message its tree')
})

test('the skill frontmatter names the skill and describes the trigger', () => {
  const text = read('skill', 'dsh-goal-autopilot', 'SKILL.md')
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text)
  assert.ok(frontmatter, 'SKILL.md starts with YAML frontmatter')
  const doc = parseDocument(frontmatter[1])
  assert.deepEqual(doc.errors, [], 'the skill frontmatter parses')
  const meta = doc.toJS()
  assert.equal(meta.name, 'dsh-goal-autopilot')
  assert.match(meta.description, /goal/i)
  assert.match(meta.description, /autopilot/i)
})

test('package.json declares the bundle patch and ships no code', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.name, 'dsh-goal-autopilot')
  assert.equal(pkg.version, '0.5.0')
  assert.equal(pkg.license, 'MIT')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.engines?.dsh, '>=0.2.2-rc.5 <0.3.0-0')
  assert.match(pkg.engines?.node ?? '', /^>=22/)

  for (const entry of ['cordis.patch.yml', 'skill', 'docs', 'README.md', 'README.zh-CN.md', 'ARCHITECTURE.md', 'CHANGELOG.md', 'LICENSE']) {
    assert.ok(pkg.files?.includes(entry), `files ships ${entry}`)
  }
  for (const entry of ['lib', 'src']) {
    assert.ok(!pkg.files?.includes(entry), `files ships no ${entry}`)
    assert.ok(!existsSync(at(entry)), `no ${entry} directory exists`)
  }
  for (const key of ['main', 'types', 'exports']) {
    assert.equal(pkg[key], undefined, `package.json has no ${key}`)
  }

  assert.equal(pkg.scripts?.test, 'node --test')
  for (const retired of ['build', 'check']) {
    assert.ok(!(retired in (pkg.scripts ?? {})), `no ${retired} script`)
  }
})

test('the release checklist exists and uses the config-only gates', () => {
  assert.ok(existsSync(at('docs', 'release.md')), 'docs/release.md exists')
  const release = read('docs', 'release.md')
  assert.match(release, /node --test\b/)
  assert.doesNotMatch(release, /pnpm run build|pnpm run check|vitest|tsc -p/)
})

test('CI and Release run the same gate commands and no typecheck', () => {
  for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const text = read(workflow)
    assert.match(text, /run: pnpm install --frozen-lockfile/, `${workflow} installs`)
    assert.match(text, /run: node --test$/m, `${workflow} tests`)
    assert.doesNotMatch(text, /tsc -p|vitest|pnpm run build/, `${workflow} runs no code gates`)
  }
})
