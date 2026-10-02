import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { buildRefresh, parseArgs as parseRunArgs } from './run.mjs'
import { parseArgs as parsePublishArgs, publishRelease } from './publish.mjs'

const require = createRequire(import.meta.url)
const { encodeDataset } = require('../pal-package.cjs')
const ORIGIN = 'https://www2.education.vic.gov.au/pal'

function dataset(version = '20261001000000') {
  const generatedAt = `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}T${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}.000Z`
  const policies = Array.from({ length: 400 }, (_, index) => ({
    id: index + 1,
    title: `Policy ${index + 1}`,
    category: 'Operations',
    tags: [],
    summary: '',
    url: `${ORIGIN}/policy-${index + 1}`,
  }))
  const bodies = Object.fromEntries(
    policies.map((policy) => [String(policy.id), `Body ${policy.id}`])
  )
  const sections = Object.fromEntries(policies.map((policy) => [String(policy.id), []]))
  const corpus = policies.map((policy) => ({
    policyId: String(policy.id),
    policyTitle: policy.title,
    category: policy.category,
    heading: 'Overview',
    url: `${policy.url}#overview`,
    text: `Body ${policy.id}`,
  }))
  return {
    schemaVersion: 1,
    version,
    generatedAt,
    linksVerified: null,
    categories: ['Operations'],
    suggestions: [],
    policies,
    bodies,
    sections,
    corpus,
    stalePolicyIds: [],
  }
}

function writePackage(directory, data, report = { partial: false }) {
  mkdirSync(directory, { recursive: true })
  const { manifest, bytes } = encodeDataset(data)
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify(manifest))
  writeFileSync(resolve(directory, manifest.file), bytes)
  writeFileSync(resolve(directory, 'report.json'), JSON.stringify(report))
}

function sandbox() {
  const root = mkdtempSync(resolve(tmpdir(), 'pal-publisher-test-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('argument parsers reject omissions and unknown options', () => {
  assert.deepEqual(parseRunArgs(['--previous', 'old', '--out', 'new']), {
    previous: resolve('old'),
    out: resolve('new'),
  })
  assert.throws(
    () => parseRunArgs(['--previous', 'old', '--limit', '1']),
    /Unknown argument/
  )
  assert.deepEqual(parsePublishArgs(['--dir', 'new']), { directory: resolve('new') })
  assert.throws(
    () => parsePublishArgs(['--dir', 'new', '--repo', 'somewhere']),
    /Usage/
  )
})

test('run validates the previous package and exposes output only after a complete refresh', async () => {
  const box = sandbox()
  try {
    const previous = resolve(box.root, 'previous')
    const out = resolve(box.root, 'out')
    writePackage(previous, dataset())
    const current = dataset('20261002060000')
    const progress = []
    await buildRefresh({
      previous,
      out,
      log: (line) => progress.push(line),
      refresh: async (_old, { onProgress }) => {
        assert.equal(existsSync(out), false)
        onProgress({ slug: 'policy-1', status: 'updated' })
        return {
          dataset: current,
          report: { partial: false, updated: [{ slug: 'policy-1' }] },
        }
      },
    })
    assert.equal(
      JSON.parse(readFileSync(resolve(out, 'manifest.json'))).version,
      current.version
    )
    assert.equal(existsSync(resolve(out, 'pal-dataset.json.gz')), true)
    assert.match(progress[0], /policy-1 — updated/)
  } finally {
    box.cleanup()
  }
})

test('run rejects partial output, leaves previous intact and publishes no output directory', async () => {
  const box = sandbox()
  try {
    const previous = resolve(box.root, 'previous')
    const out = resolve(box.root, 'out')
    writePackage(previous, dataset())
    const before = readFileSync(resolve(previous, 'pal-dataset.json.gz'))
    await assert.rejects(
      buildRefresh({
        previous,
        out,
        log: () => {},
        refresh: async () => ({
          dataset: dataset('20261002060000'),
          report: { partial: true },
        }),
      }),
      /partial/
    )
    assert.equal(existsSync(out), false)
    assert.deepEqual(readFileSync(resolve(previous, 'pal-dataset.json.gz')), before)
  } finally {
    box.cleanup()
  }
})

test('publisher uses the fixed repository, verifies downloaded assets, then publishes latest', async () => {
  const box = sandbox()
  try {
    const directory = resolve(box.root, 'package')
    writePackage(directory, dataset())
    const calls = []
    const runGh = (args) => {
      calls.push(args)
      assert.ok(args[0] === 'api' || args.includes('Vurctne/lumera-pal-data'))
      if (args[0] === 'api')
        return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' }
      if (args[0] === 'release' && args[1] === 'download') {
        const target = args[args.indexOf('--dir') + 1]
        for (const name of ['manifest.json', 'pal-dataset.json.gz', 'report.json'])
          cpSync(resolve(directory, name), resolve(target, name))
      }
      return { status: 0, stdout: '', stderr: '' }
    }
    const result = await publishRelease({ directory, runGh, log: () => {} })
    assert.equal(result.tag, 'pal-20261001000000')
    assert.deepEqual(
      calls.map((args) => args.slice(0, 2)),
      [
        ['api', 'repos/Vurctne/lumera-pal-data/releases/tags/pal-20261001000000'],
        ['release', 'create'],
        ['release', 'download'],
        ['release', 'edit'],
      ]
    )
    assert.ok(calls.at(-1).includes('--latest'))
  } finally {
    box.cleanup()
  }
})

test('publisher refuses an existing version before creating or editing a release', async () => {
  const box = sandbox()
  try {
    const directory = resolve(box.root, 'package')
    writePackage(directory, dataset())
    const calls = []
    await assert.rejects(
      publishRelease({
        directory,
        log: () => {},
        runGh(args) {
          calls.push(args)
          return { status: 0, stdout: '{}', stderr: '' }
        },
      }),
      /already exists/
    )
    assert.equal(calls.length, 1)
  } finally {
    box.cleanup()
  }
})

test('publisher leaves a corrupt draft unpublished when downloaded checksum verification fails', async () => {
  const box = sandbox()
  try {
    const directory = resolve(box.root, 'package')
    writePackage(directory, dataset())
    const calls = []
    await assert.rejects(
      publishRelease({
        directory,
        log: () => {},
        runGh(args) {
          calls.push(args)
          if (args[0] === 'api')
            return { status: 1, stdout: '', stderr: 'HTTP 404: Not Found' }
          if (args[0] === 'release' && args[1] === 'download') {
            const target = args[args.indexOf('--dir') + 1]
            cpSync(
              resolve(directory, 'manifest.json'),
              resolve(target, 'manifest.json')
            )
            cpSync(resolve(directory, 'report.json'), resolve(target, 'report.json'))
            writeFileSync(resolve(target, 'pal-dataset.json.gz'), 'corrupt')
          }
          return { status: 0, stdout: '', stderr: '' }
        },
      }),
      /checksum mismatch/
    )
    assert.equal(
      calls.some((args) => args[0] === 'release' && args[1] === 'edit'),
      false
    )
  } finally {
    box.cleanup()
  }
})
