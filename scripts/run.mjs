#!/usr/bin/env node
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshDataset } from './refresh.mjs'

const require = createRequire(import.meta.url)
const {
  decodeDataset,
  encodeDataset,
  validateDataset,
  validateManifest,
} = require('../pal-package.cjs')
const HERE = dirname(fileURLToPath(import.meta.url))

function usage() {
  return 'Usage: node run.mjs --previous DIR --out DIR'
}

export function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (name !== '--previous' && name !== '--out')
      throw new Error(`${usage()}\nUnknown argument: ${name}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--'))
      throw new Error(`${usage()}\nMissing value for ${name}`)
    if (values.has(name)) throw new Error(`${usage()}\nDuplicate argument: ${name}`)
    values.set(name, value)
    index += 1
  }
  if (!values.has('--previous') || !values.has('--out')) throw new Error(usage())
  return {
    previous: resolve(values.get('--previous')),
    out: resolve(values.get('--out')),
  }
}

async function readPackage(directory) {
  const manifestPath = resolve(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  validateManifest(manifest)
  const payload = await readFile(resolve(directory, manifest.file))
  return { manifest, dataset: decodeDataset(manifest, payload) }
}

function progressLine(event) {
  if (typeof event === 'string') return event.replace(/\s+/g, ' ').trim()
  if (!event || typeof event !== 'object') return ''
  const slug = event.slug || event.policy || event.id || ''
  const status = event.status || event.phase || event.action || 'processed'
  return [slug, status].filter(Boolean).join(' — ')
}

export async function buildRefresh({
  previous,
  out,
  refresh = refreshDataset,
  log = console.error,
}) {
  if (resolve(previous) === resolve(out))
    throw new Error('--previous and --out must be different directories')
  const { dataset: oldDataset } = await readPackage(previous)
  const parent = dirname(out)
  await mkdir(parent, { recursive: true })
  const temporary = resolve(
    parent,
    `.${basename(out)}.tmp-${process.pid}-${Date.now()}`
  )
  await mkdir(temporary, { recursive: false })

  try {
    const result = await refresh(oldDataset, {
      onProgress(event) {
        const line = progressLine(event)
        if (line) log(line)
      },
    })
    if (!result || typeof result !== 'object')
      throw new Error('PAL refresh returned no result')
    const { dataset, report } = result
    if (!report || typeof report !== 'object')
      throw new Error('PAL refresh returned no report')
    if (report.partial) throw new Error('Refusing to publish a partial PAL refresh')
    validateDataset(dataset)
    const encoded = encodeDataset(dataset)
    validateManifest(encoded.manifest)
    decodeDataset(encoded.manifest, encoded.bytes)

    await writeFile(
      resolve(temporary, 'manifest.json'),
      `${JSON.stringify(encoded.manifest, null, 2)}\n`,
      { flag: 'wx' }
    )
    await writeFile(resolve(temporary, encoded.manifest.file), encoded.bytes, {
      flag: 'wx',
    })
    await writeFile(
      resolve(temporary, 'report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      { flag: 'wx' }
    )

    // A fresh destination makes the directory rename atomic: consumers see
    // either no output or a complete, validated package.
    await rename(temporary, out)
    log(`complete — ${dataset.policies.length} policies — ${encoded.manifest.version}`)
    return { manifest: encoded.manifest, report }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  await buildRefresh(options)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`PAL refresh failed: ${error?.message || error}`)
    process.exitCode = 1
  })
}
