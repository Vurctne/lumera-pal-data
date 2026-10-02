#!/usr/bin/env node
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const { decodeDataset, validateManifest } = require('../pal-package.cjs')
const REPOSITORY = 'Vurctne/lumera-pal-data'

function usage() {
  return 'Usage: node publish.mjs --dir DIR'
}

export function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--dir' || !argv[1] || argv[1].startsWith('--'))
    throw new Error(usage())
  return { directory: resolve(argv[1]) }
}

function defaultGh(args, options = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: process.env.GITHUB_TOKEN
      ? { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN }
      : process.env,
  })
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

function checked(runGh, args, options) {
  const result = runGh(args, options) || {}
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(`gh ${args[0]} failed${detail ? `: ${detail}` : ''}`)
  }
  return result
}

async function validateDirectory(directory) {
  const manifestPath = resolve(directory, 'manifest.json')
  const reportPath = resolve(directory, 'report.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  validateManifest(manifest)
  const payloadPath = resolve(directory, manifest.file)
  decodeDataset(manifest, await readFile(payloadPath))
  const report = JSON.parse(await readFile(reportPath, 'utf8'))
  if (!report || typeof report !== 'object' || report.partial)
    throw new Error('Refusing to publish an invalid or partial PAL report')
  return { manifest, manifestPath, payloadPath, reportPath }
}

export async function publishRelease({
  directory,
  runGh = defaultGh,
  log = console.error,
}) {
  const files = await validateDirectory(directory)
  const tag = `pal-${files.manifest.version}`

  const existing = runGh(
    ['api', `repos/${REPOSITORY}/releases/tags/${tag}`, '--silent'],
    { capture: true }
  )
  if (existing.status === 0)
    throw new Error(`Release ${tag} already exists; versions are immutable`)
  const missingText = `${existing.stdout || ''}\n${existing.stderr || ''}`
  if (!/\b404\b|not found/i.test(missingText))
    throw new Error(
      `Could not prove ${tag} is unused: ${missingText.trim() || 'gh api failed'}`
    )

  checked(runGh, [
    'release',
    'create',
    tag,
    '--repo',
    REPOSITORY,
    '--title',
    `Lumera PAL data ${files.manifest.version}`,
    '--notes',
    `Validated PAL reference data generated ${files.manifest.generatedAt}.`,
    '--draft',
    '--latest=false',
    files.manifestPath,
    files.payloadPath,
    files.reportPath,
  ])
  log(`draft uploaded — ${tag}`)

  const download = await mkdtemp(resolve(tmpdir(), 'lumera-pal-release-'))
  try {
    checked(runGh, [
      'release',
      'download',
      tag,
      '--repo',
      REPOSITORY,
      '--dir',
      download,
      '--pattern',
      'manifest.json',
      '--pattern',
      files.manifest.file,
      '--pattern',
      'report.json',
    ])
    const downloadedManifest = JSON.parse(
      await readFile(resolve(download, 'manifest.json'), 'utf8')
    )
    validateManifest(downloadedManifest)
    if (JSON.stringify(downloadedManifest) !== JSON.stringify(files.manifest))
      throw new Error('Downloaded draft manifest differs from the uploaded manifest')
    decodeDataset(
      downloadedManifest,
      await readFile(resolve(download, downloadedManifest.file))
    )
    const downloadedReport = JSON.parse(
      await readFile(resolve(download, 'report.json'), 'utf8')
    )
    if (
      !downloadedReport ||
      typeof downloadedReport !== 'object' ||
      downloadedReport.partial
    )
      throw new Error('Downloaded draft report is invalid or partial')

    checked(runGh, [
      'release',
      'edit',
      tag,
      '--repo',
      REPOSITORY,
      '--draft=false',
      '--latest',
    ])
    log(`published latest — ${tag}`)
    return { repository: REPOSITORY, tag }
  } finally {
    await rm(download, { recursive: true, force: true })
  }
}

async function main() {
  const { directory } = parseArgs(process.argv.slice(2))
  await publishRelease({ directory })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`PAL publish failed: ${error?.message || error}`)
    process.exitCode = 1
  })
}
