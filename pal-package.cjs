// PAL updates contain JSON reference data only. No scripts, paths or executable assets.
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const MAX_COMPRESSED = 16 * 1024 * 1024
const MAX_UNPACKED = 64 * 1024 * 1024
const VERSION_RE = /^\d{14}$/
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const object = (value) => value && typeof value === 'object' && !Array.isArray(value)
function assert(value, message) {
  if (!value) throw new Error(message)
}
function text(value, max = 4000, empty = false) {
  return (
    typeof value === 'string' &&
    (empty || value.trim().length > 0) &&
    value.length <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  )
}
function iso(value) {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  )
}
function versionFor(date) {
  return date.toISOString().replace(/\D/g, '').slice(0, 14)
}
function validVersion(version) {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return false
  const isoDate = `${version.slice(0, 4)}-${version.slice(4, 6)}-${version.slice(6, 8)}T${version.slice(8, 10)}:${version.slice(10, 12)}:${version.slice(12, 14)}.000Z`
  return iso(isoDate) && versionFor(new Date(isoDate)) === version
}
function safeUrl(raw, policy = true) {
  if (!text(raw, 4096)) return false
  try {
    const url = new URL(raw)
    return (
      (policy
        ? url.protocol === 'https:'
        : ['https:', 'http:'].includes(url.protocol)) &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.hostname.includes('.') &&
      (!policy ||
        (url.hostname === 'www2.education.vic.gov.au' &&
          (policy === 'source' || url.pathname.startsWith('/pal/'))))
    )
  } catch {
    return false
  }
}
function validateDataset(data, { minPolicies = 400 } = {}) {
  assert(
    object(data) &&
      data.schemaVersion === 1 &&
      validVersion(data.version) &&
      iso(data.generatedAt),
    'Invalid PAL dataset header'
  )
  assert(
    versionFor(new Date(data.generatedAt)) === data.version,
    'PAL version/date mismatch'
  )
  assert(
    data.linksVerified === null ||
      (typeof data.linksVerified === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(data.linksVerified) &&
        iso(`${data.linksVerified}T00:00:00.000Z`)),
    'Invalid verification date'
  )
  assert(
    Array.isArray(data.categories) &&
      data.categories.length >= 1 &&
      data.categories.length <= 50 &&
      data.categories.every((x) => text(x, 100)) &&
      new Set(data.categories).size === data.categories.length,
    'Invalid PAL categories'
  )
  assert(
    Array.isArray(data.suggestions) &&
      data.suggestions.length <= 50 &&
      data.suggestions.every((x) => text(x, 200)),
    'Invalid search suggestions'
  )
  assert(
    Array.isArray(data.policies) &&
      data.policies.length >= minPolicies &&
      data.policies.length <= 1500,
    'Invalid PAL policy count'
  )
  const ids = new Set()
  for (const p of data.policies) {
    assert(
      object(p) &&
        Number.isFinite(p.id) &&
        p.id > 0 &&
        p.id < Number.MAX_SAFE_INTEGER &&
        !ids.has(String(p.id)),
      'Invalid or duplicate policy id'
    )
    ids.add(String(p.id))
    assert(
      text(p.title) &&
        text(p.summary, 20000, true) &&
        data.categories.includes(p.category) &&
        safeUrl(p.url),
      'Invalid policy metadata'
    )
    assert(
      Array.isArray(p.tags) &&
        p.tags.length <= 200 &&
        p.tags.every((t) => text(t, 1000)),
      'Invalid policy tags'
    )
    if (p.popular !== undefined)
      assert(typeof p.popular === 'boolean', 'Invalid popular flag')
    if (p.tabs !== undefined) {
      if (Array.isArray(p.tabs))
        assert(
          p.tabs.length <= 20 && p.tabs.every((x) => text(x)),
          'Invalid policy tabs'
        )
      else
        assert(
          object(p.tabs) &&
            Object.entries(p.tabs).every(
              ([k, v]) =>
                [
                  'overview',
                  'policyAndGuidelines',
                  'guidance',
                  'resources',
                  'procedure',
                ].includes(k) && safeUrl(v)
            ),
          'Invalid policy tabs'
        )
    }
    for (const key of ['chapters', 'resources'])
      if (p[key] !== undefined) {
        assert(Array.isArray(p[key]) && p[key].length <= 3000, 'Invalid policy links')
        for (const link of p[key]) {
          assert(
            object(link) &&
              Object.keys(link).length > 0 &&
              Object.entries(link).every(([k, v]) =>
                ['url', 'href'].includes(k)
                  ? safeUrl(v, false)
                  : ['title', 'label', 'note'].includes(k) && text(v, 20000, true)
              ),
            'Invalid policy link'
          )
        }
      }
  }
  for (const key of ['bodies', 'sections'])
    assert(
      object(data[key]) && Object.keys(data[key]).every((id) => ids.has(id)),
      `Invalid PAL ${key} ids`
    )
  assert(
    Object.keys(data.bodies).length >= Math.floor(data.policies.length * 0.85),
    'PAL body coverage too low'
  )
  for (const value of Object.values(data.bodies))
    assert(text(value, 8 * 1024 * 1024), 'Invalid policy body')
  for (const sections of Object.values(data.sections)) {
    assert(Array.isArray(sections) && sections.length <= 10000, 'Invalid sections')
    const urls = new Set()
    for (const section of sections) {
      assert(
        object(section) &&
          text(section.heading) &&
          safeUrl(section.url, 'source') &&
          !urls.has(section.url),
        'Invalid or duplicate section'
      )
      urls.add(section.url)
    }
  }
  assert(
    Array.isArray(data.corpus) &&
      data.corpus.length > 0 &&
      data.corpus.length <= 100000,
    'Invalid PAL corpus'
  )
  const seen = new Set(),
    corpusIds = new Set()
  for (const c of data.corpus) {
    assert(
      object(c) &&
        ids.has(c.policyId) &&
        text(c.policyTitle) &&
        data.categories.includes(c.category) &&
        text(c.heading) &&
        safeUrl(c.url, 'source') &&
        text(c.text, 8 * 1024 * 1024),
      'Invalid PAL chunk'
    )
    const key = c.policyId + '|' + c.url
    assert(!seen.has(key), 'Duplicate PAL chunk')
    seen.add(key)
    corpusIds.add(c.policyId)
  }
  assert(
    corpusIds.size >= Math.floor(data.policies.length * 0.85),
    'PAL corpus coverage too low'
  )
  assert(
    Array.isArray(data.stalePolicyIds) &&
      new Set(data.stalePolicyIds).size === data.stalePolicyIds.length &&
      data.stalePolicyIds.every((id) => ids.has(id)),
    'Invalid PAL stale ids'
  )
  assert(
    data.stalePolicyIds.length <= Math.max(1, Math.floor(data.policies.length * 0.05)),
    'Too many stale policies'
  )
  return data
}
function validateManifest(m) {
  assert(
    object(m) &&
      m.schemaVersion === 1 &&
      validVersion(m.version) &&
      iso(m.generatedAt) &&
      versionFor(new Date(m.generatedAt)) === m.version,
    'Invalid PAL manifest'
  )
  assert(
    m.minAppVersion === '3.0.7' && m.file === 'pal-dataset.json.gz',
    'Unsupported PAL format'
  )
  assert(
    Number.isSafeInteger(m.bytes) &&
      m.bytes > 0 &&
      m.bytes <= MAX_COMPRESSED &&
      Number.isSafeInteger(m.unpackedBytes) &&
      m.unpackedBytes > 0 &&
      m.unpackedBytes <= MAX_UNPACKED &&
      /^[a-f0-9]{64}$/.test(m.sha256),
    'Invalid PAL payload size/hash'
  )
  return m
}
function encodeDataset(data) {
  validateDataset(data)
  const plain = Buffer.from(JSON.stringify(data))
  const bytes = zlib.gzipSync(plain, { level: 9 })
  const manifest = {
    schemaVersion: 1,
    version: data.version,
    generatedAt: data.generatedAt,
    minAppVersion: '3.0.7',
    file: 'pal-dataset.json.gz',
    bytes: bytes.length,
    unpackedBytes: plain.length,
    sha256: sha256(bytes),
  }
  validateManifest(manifest)
  return { manifest, bytes }
}
function decodeDataset(manifest, bytes, options) {
  validateManifest(manifest)
  assert(
    bytes.length === manifest.bytes && sha256(bytes) === manifest.sha256,
    'PAL download checksum mismatch'
  )
  const plain = zlib.gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED })
  assert(plain.length === manifest.unpackedBytes, 'PAL unpacked size mismatch')
  const data = validateDataset(JSON.parse(plain.toString('utf8')), options)
  assert(
    data.version === manifest.version && data.generatedAt === manifest.generatedAt,
    'PAL manifest/data version mismatch'
  )
  return data
}
function metadata(data) {
  const {
    schemaVersion,
    version,
    generatedAt,
    linksVerified,
    policies,
    categories,
    suggestions,
    stalePolicyIds,
  } = data
  return {
    schemaVersion,
    version,
    generatedAt,
    linksVerified,
    policies,
    categories,
    suggestions,
    stalePolicyIds,
  }
}
module.exports = {
  MAX_COMPRESSED,
  MAX_UNPACKED,
  sha256,
  validVersion,
  versionFor,
  safeUrl,
  validateDataset,
  validateManifest,
  encodeDataset,
  decodeDataset,
  metadata,
}
