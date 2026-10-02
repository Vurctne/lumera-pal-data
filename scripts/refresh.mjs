const ORIGIN = 'https://www2.education.vic.gov.au'
const SITEMAP_URL = `${ORIGIN}/sitemap.xml`
const TIMEOUT_MS = 25_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const NON_POLICIES = new Set([
  'about-pal',
  'pal-help',
  'recently-updated',
  'school-policy-templates-portal',
])
const TEST_POLICY = /(^|-)test(-|$)/i
const UA =
  'Lumera PAL weekly publisher (https://github.com/Vurctne/lumera-pal-data; public data refresh)'

class StopRunError extends Error {
  constructor(url, status) {
    super(`PAL refused the refresh with HTTP ${status}: ${url}`)
    this.name = 'StopRunError'
    this.url = url
    this.status = status
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function requestClient(fetchImpl, delayMs) {
  let lastStarted = 0

  async function one(url) {
    const elapsed = Date.now() - lastStarted
    if (lastStarted && elapsed < delayMs) await sleep(delayMs - elapsed)
    lastStarted = Date.now()
    const controller = new AbortController()
    let timer
    try {
      const operation = (async () => {
        const response = await fetchImpl(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            Accept: 'text/html,application/xml;q=0.9,*/*;q=0.1',
            'User-Agent': UA,
          },
        })
        if (response.status === 403 || response.status === 429)
          throw new StopRunError(url, response.status)
        const declared = Number(response.headers?.get?.('content-length'))
        if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
          throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
        let text = ''
        if (response.body?.getReader) {
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let received = 0
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            received += value.byteLength
            if (received > MAX_RESPONSE_BYTES) {
              await reader.cancel()
              throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
            }
            text += decoder.decode(value, { stream: true })
          }
          text += decoder.decode()
        } else {
          text = await response.text()
          if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES)
            throw new Error(`response exceeds ${MAX_RESPONSE_BYTES} bytes`)
        }
        return {
          ok: response.ok,
          status: response.status,
          headers: response.headers,
          text,
        }
      })()
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`request timed out after ${TIMEOUT_MS}ms`))
        }, TIMEOUT_MS)
      })
      return await Promise.race([operation, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  return async function get(startUrl) {
    let url = startUrl
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      let response
      let error
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await one(url)
          if (response.status === 403 || response.status === 429)
            throw new StopRunError(url, response.status)
          if (response.status < 500 || attempt === 1) break
        } catch (cause) {
          if (cause instanceof StopRunError) throw cause
          error = cause
          if (attempt === 1)
            return { ok: false, status: -1, url, text: '', error: brief(cause) }
        }
      }
      if (!response)
        return { ok: false, status: -1, url, text: '', error: brief(error) }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get?.('location')
        if (!location)
          return {
            ok: false,
            status: response.status,
            url,
            text: '',
            error: 'redirect without Location',
          }
        const next = new URL(location, url)
        if (next.origin !== ORIGIN)
          return {
            ok: false,
            status: response.status,
            url,
            text: '',
            error: `cross-host redirect to ${next.origin}`,
          }
        url = next.href
        continue
      }
      const text = response.ok ? response.text : ''
      return {
        ok: response.ok,
        status: response.status,
        url,
        text,
        error: response.ok ? '' : `HTTP ${response.status}`,
      }
    }
    return { ok: false, status: -1, url, text: '', error: 'too many redirects' }
  }
}

function brief(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
}

function decodeEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
    ndash: '–',
    mdash: '—',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    hellip: '…',
  }
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (whole, entity) => {
    if (entity[0] === '#') {
      const hex = entity[1]?.toLowerCase() === 'x'
      const number = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      return Number.isFinite(number) && number > 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : whole
    }
    return named[entity.toLowerCase()] ?? whole
  })
}

function plain(html) {
  return decodeEntities(
    html
      .replace(/<!--[^]*?-->/g, ' ')
      .replace(/<(script|style|template)\b[^>]*>[^]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim()
}

function attr(tag, name) {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  )
  return decodeEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '')
}

function mainHtml(html) {
  const match = html.match(/<main\b[^>]*>([^]*?)<\/main>/i)
  if (!match) return ''
  return match[1]
    .replace(/<(nav|aside|header|footer)\b[^>]*>[^]*?<\/\1>/gi, ' ')
    .replace(
      /<div\b[^>]*class=["'][^"']*(?:in-page-navigation|breadcrumbs)[^"']*["'][^>]*>[^]*?<\/div>/gi,
      ' '
    )
}

function h1(html) {
  return plain(html.match(/<h1\b[^>]*>([^]*?)<\/h1>/i)?.[1] || '')
}

function metaDescription(html) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (/\b(?:name|property)\s*=\s*["'](?:description|og:description)["']/i.test(tag))
      return attr(tag, 'content')
  }
  return ''
}

function shortSourceText(value, maximum = 420) {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= maximum) return text
  const clipped = text.slice(0, maximum - 1)
  const boundary = clipped.lastIndexOf(' ')
  return `${clipped.slice(0, boundary > maximum * 0.7 ? boundary : clipped.length).trim()}…`
}

function isMaintenance(html) {
  const title = plain(html.match(/<title\b[^>]*>([^]*?)<\/title>/i)?.[1] || '')
  const heading = h1(html)
  const body = plain(mainHtml(html)).slice(0, 600)
  return (
    /\bmaintenance\b/i.test(`${title} ${heading}`) ||
    /(?:site|page|service).{0,40}(?:undergoing maintenance|temporarily unavailable)/i.test(
      body
    )
  )
}

function slugFromUrl(value) {
  try {
    const url = new URL(value)
    if (url.origin !== ORIGIN) return null
    const match = url.pathname.match(/^\/pal\/([^/]+)(?:\/|$)/)
    return match ? decodeURIComponent(match[1]).toLowerCase() : null
  } catch {
    return null
  }
}

function sitemapSlugs(xml) {
  const slugs = new Set()
  for (const match of xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
    const slug = slugFromUrl(decodeEntities(match[1]))
    if (slug && !NON_POLICIES.has(slug) && !TEST_POLICY.test(slug)) slugs.add(slug)
  }
  return [...slugs].sort()
}

function validPolicyLink(value, base, slug) {
  try {
    const url = new URL(decodeEntities(value), base)
    url.hash = ''
    if (url.origin !== ORIGIN || slugFromUrl(url.href) !== slug) return null
    if (!/^\/pal\/[a-z0-9-]+(?:\/[a-z0-9-]+)*\/?$/i.test(url.pathname)) return null
    if (/\.(?:pdf|docx?|xlsx?|pptx?|zip|csv)(?:$|[?#])/i.test(url.pathname)) return null
    return url.href
  } catch {
    return null
  }
}

export function isPolicyChapter(chapter) {
  const title = String(chapter?.title || '').trim()
  if (/^skip to main content$/i.test(title)) return false
  const value = chapter?.url || chapter?.href
  try {
    return !/\/print-all\/?$/i.test(new URL(value, ORIGIN).pathname)
  } catch {
    return true
  }
}

export function filterPolicyChapters(chapters) {
  if (!Array.isArray(chapters)) return []
  return chapters.filter(isPolicyChapter)
}

function pageLinks(html, base, slug) {
  const links = []
  const seen = new Set()
  for (const match of html.matchAll(/<a\b([^>]*)>([^]*?)<\/a>/gi)) {
    const url = validPolicyLink(attr(match[1], 'href'), base, slug)
    const title = plain(match[2])
    if (!url || !title || !isPolicyChapter({ title, url }) || seen.has(url)) continue
    seen.add(url)
    links.push({ title, url })
  }
  return links
}

function resourceLinks(main, base) {
  const resources = []
  const seen = new Set()
  const heading =
    /<h([2-4])\b[^>]*\bid\s*=\s*["']resources["'][^>]*>[^]*?<\/h\1>/i.exec(main)
  if (!heading) return resources
  const rest = main.slice(heading.index + heading[0].length)
  const nextTopHeading = rest.search(/<h2\b/i)
  const block = nextTopHeading >= 0 ? rest.slice(0, nextTopHeading) : rest
  for (const match of block.matchAll(/<a\b([^>]*)>([^]*?)<\/a>/gi)) {
    const title = plain(match[2])
    if (!title) continue
    const href = decodeEntities(attr(match[1], 'href')).trim()
    if (!href || /[\u0000-\u001f\s]/.test(href) || /^[:]+/.test(href)) continue
    let url
    try {
      url = new URL(href, base)
    } catch {
      continue
    }
    if (!/^https?:$/.test(url.protocol) || seen.has(url.href)) continue
    seen.add(url.href)
    resources.push({ title, url: url.href })
  }
  return resources
}

function canonicalPolicyUrl(html, finalUrl, slug) {
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    if (!/\brel\s*=\s*["'][^"']*canonical[^"']*["']/i.test(tag)) continue
    const url = validPolicyLink(attr(tag, 'href'), finalUrl, slug)
    if (url && !/\/print-all\/?$/i.test(new URL(url).pathname)) return url
  }
  const url = new URL(finalUrl)
  url.hash = ''
  url.search = ''
  url.pathname = url.pathname.replace(/\/print-all\/?$/i, '') || `/pal/${slug}`
  return url.href.replace(/\/$/, '')
}

function extractPage(html, sourceUrl, slug) {
  const main = mainHtml(html)
  if (!main || !h1(html) || isMaintenance(html))
    throw new Error('maintenance or incomplete PAL page')
  const headingRe = /<h([2-4])\b([^>]*)>([^]*?)<\/h\1>/gi
  const headings = []
  let match
  while ((match = headingRe.exec(main))) {
    const id = attr(match[2], 'id')
    const heading = plain(match[3])
    if (!id || !heading || headings.some((item) => item.id === id)) continue
    headings.push({ id, heading, start: match.index, bodyStart: headingRe.lastIndex })
  }
  const sections = []
  const chunks = []
  for (let index = 0; index < headings.length; index += 1) {
    const item = headings[index]
    const text = plain(
      main.slice(item.bodyStart, headings[index + 1]?.start ?? main.length)
    )
    const url = `${sourceUrl.split('#')[0]}#${encodeURIComponent(item.id)}`
    sections.push({ heading: item.heading, url })
    if (text) chunks.push({ heading: item.heading, url, text })
  }
  const summaryHeading = headings.findIndex((item) => /^summary$/i.test(item.heading))
  const summaryBlock =
    summaryHeading >= 0
      ? main.slice(
          headings[summaryHeading].bodyStart,
          headings[summaryHeading + 1]?.start ?? main.length
        )
      : ''
  const firstParagraph = plain(summaryBlock.match(/<p\b[^>]*>([^]*?)<\/p>/i)?.[1] || '')
  const fullSummary = plain(summaryBlock)
  const body = plain(main)
  const shortLead =
    firstParagraph &&
    fullSummary.length > firstParagraph.length + 20 &&
    (/[:：]\s*$/.test(firstParagraph) || firstParagraph.length < 80)
  const substantiveChunk = chunks.find(
    (chunk) =>
      !/^(?:resources|related policies|policy last updated|scope|date)$/i.test(
        chunk.heading.trim()
      ) && chunk.text.split(/\s+/).length >= 8
  )
  const summarySource = summaryBlock
    ? shortLead
      ? fullSummary
      : firstParagraph || fullSummary
    : metaDescription(html) || substantiveChunk?.text || body
  const summary = shortSourceText(summarySource)
  if (!chunks.length && body)
    chunks.push({ heading: h1(html), url: sourceUrl.split('#')[0], text: body })
  return {
    title: h1(html),
    summary,
    body,
    sections,
    chunks,
    links: pageLinks(html, sourceUrl, slug),
    resources: resourceLinks(main, sourceUrl),
    canonicalUrl: canonicalPolicyUrl(html, sourceUrl, slug),
  }
}

function combinePages(pages) {
  const sectionSeen = new Set()
  const chunkSeen = new Set()
  const linkSeen = new Set()
  const resourceSeen = new Set()
  return pages.reduce(
    (all, page) => {
      all.body.push(page.body)
      for (const section of page.sections) {
        if (!sectionSeen.has(section.url)) {
          sectionSeen.add(section.url)
          all.sections.push(section)
        }
      }
      for (const chunk of page.chunks) {
        if (!chunkSeen.has(chunk.url)) {
          chunkSeen.add(chunk.url)
          all.chunks.push(chunk)
        }
      }
      for (const link of page.links) {
        if (!linkSeen.has(link.url)) {
          linkSeen.add(link.url)
          all.links.push(link)
        }
      }
      for (const resource of page.resources) {
        if (!resourceSeen.has(resource.url)) {
          resourceSeen.add(resource.url)
          all.resources.push(resource)
        }
      }
      if (!all.title) all.title = page.title
      if (!all.summary) all.summary = page.summary
      if (!all.canonicalUrl) all.canonicalUrl = page.canonicalUrl
      return all
    },
    {
      title: '',
      summary: '',
      body: [],
      sections: [],
      chunks: [],
      links: [],
      resources: [],
      canonicalUrl: '',
    }
  )
}

function stableId(slug, used) {
  let hash = 2166136261
  for (const byte of new TextEncoder().encode(slug)) {
    hash ^= byte
    hash = Math.imul(hash, 16777619)
  }
  let id = 1_000_000_000 + (hash >>> 0)
  while (used.has(String(id))) id += 1
  return id
}

function tabsAndChapters(links, slug) {
  const tabs = {}
  const chapters = []
  const tabNames = {
    overview: 'overview',
    policy: 'policyAndGuidelines',
    'policy-and-guidelines': 'policyAndGuidelines',
    'policy-and-guidance': 'policyAndGuidelines',
    guidance: 'guidance',
    resources: 'resources',
    procedure: 'procedure',
  }
  for (const link of links) {
    const url = new URL(link.url)
    const tail = url.pathname.split('/').filter(Boolean).slice(2)
    if (!tail.length) continue
    if (tail.length === 1 && tabNames[tail[0]]) tabs[tabNames[tail[0]]] ??= link.url
    else chapters.push({ title: link.title, url: link.url })
  }
  return {
    ...(Object.keys(tabs).length ? { tabs } : {}),
    ...(chapters.length ? { chapters } : {}),
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** Remove scraper navigation artefacts from an already fetched dataset.
 * This is intentionally pure so a downloaded package can be repaired
 * deterministically without another PAL crawl. */
export function sanitizeDatasetNavigationLinks(dataset) {
  if (!dataset || !Array.isArray(dataset.policies))
    throw new TypeError('dataset must contain a policies array')
  return {
    ...dataset,
    policies: dataset.policies.map((policy) => {
      if (!Array.isArray(policy.chapters)) return policy
      const chapters = filterPolicyChapters(policy.chapters)
      if (chapters.length === policy.chapters.length) return policy
      const cleaned = { ...policy }
      if (chapters.length) cleaned.chapters = chapters
      else delete cleaned.chapters
      return cleaned
    }),
  }
}

function isShallowPolicy(policy, slug) {
  try {
    const parts = new URL(policy.url).pathname.split('/').filter(Boolean)
    return parts[0] === 'pal' && parts[1] === slug && parts.length <= 3
  } catch {
    return false
  }
}

function titleWords(value) {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  )
}

function titleSimilarity(left, right) {
  const a = titleWords(left)
  const b = titleWords(right)
  let shared = 0
  for (const word of a) if (b.has(word)) shared += 1
  return shared / Math.max(a.size + b.size - shared, 1)
}

function topLevelId(group, slug, officialTitle) {
  if (group.length === 1) return String(group[0].id)
  const shallow = group.filter((policy) => isShallowPolicy(policy, slug))
  if (!shallow.length) return null
  return String(
    shallow.sort(
      (a, b) =>
        titleSimilarity(b.title, officialTitle) -
        titleSimilarity(a.title, officialTitle)
    )[0].id
  )
}

function relocatedPolicyUrl(policy, oldSlug, newSlug, fresh, topId) {
  if (String(policy.id) === topId)
    return fresh.canonicalUrl || `${ORIGIN}/pal/${newSlug}`
  try {
    const old = new URL(policy.url)
    const oldTail = old.pathname.split('/').filter(Boolean).slice(2).join('/')
    const matching = fresh.links.find((link) => {
      const tail = new URL(link.url).pathname
        .split('/')
        .filter(Boolean)
        .slice(2)
        .join('/')
      return tail === oldTail
    })
    return (
      matching?.url ||
      (oldSlug === newSlug
        ? policy.url
        : fresh.canonicalUrl || `${ORIGIN}/pal/${newSlug}`)
    )
  } catch {
    return fresh.canonicalUrl || `${ORIGIN}/pal/${newSlug}`
  }
}

function resultRecord(slug, extra = {}) {
  return { slug, ...extra }
}

export async function refreshDataset(
  previous,
  {
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    delayMs = 2100,
    limit = null,
    onProgress = null,
  } = {}
) {
  if (!previous || previous.schemaVersion !== 1 || !Array.isArray(previous.policies))
    throw new TypeError('previous must be a schemaVersion 1 PAL dataset')
  if (typeof fetchImpl !== 'function')
    throw new TypeError('fetchImpl must be a function')
  if (!Number.isFinite(delayMs) || delayMs < 0)
    throw new RangeError('delayMs must be non-negative')
  if (limit !== null && (!Number.isInteger(limit) || limit < 0))
    throw new RangeError('limit must be null or a non-negative integer')
  if (onProgress !== null && typeof onProgress !== 'function')
    throw new TypeError('onProgress must be a function or null')

  const get = requestClient(fetchImpl, delayMs)
  const sitemap = await get(SITEMAP_URL)
  if (!sitemap.ok)
    throw new Error(`Could not fetch PAL sitemap: ${sitemap.error || sitemap.status}`)

  const old = clone(previous)
  const policiesBySlug = new Map()
  for (const policy of old.policies) {
    const slug = slugFromUrl(policy.url)
    if (!slug) continue
    if (!policiesBySlug.has(slug)) policiesBySlug.set(slug, [])
    policiesBySlug.get(slug).push(policy)
  }
  const live = new Set(sitemapSlugs(sitemap.text))
  const knownSlugs = [...policiesBySlug.keys()].sort()
  const allSlugs = [
    ...knownSlugs,
    ...[...live].filter((slug) => !policiesBySlug.has(slug)).sort(),
  ]
  const selected = limit === null ? allSlugs : allSlugs.slice(0, limit)
  const report = {
    partial: limit !== null,
    processed: [],
    updated: [],
    stale: [],
    added: [],
    retired: [],
    failed: [],
    skipped: [],
    sources: { sitemap: SITEMAP_URL, policies: [] },
  }
  if (limit !== null)
    for (const slug of allSlugs.slice(limit))
      report.skipped.push(resultRecord(slug, { reason: 'limit' }))

  const replacements = new Map()
  const additions = []
  const retired = new Set()
  const stale = new Set()
  const usedIds = new Set(old.policies.map((policy) => String(policy.id)))
  const claimedLiveSlugs = new Set()
  const emitProgress = async (slug, status) => {
    if (onProgress)
      await onProgress({
        completed: report.processed.length,
        total: selected.length,
        slug,
        status,
      })
  }

  for (const slug of selected) {
    if (claimedLiveSlugs.has(slug)) {
      report.skipped.push(
        resultRecord(slug, { reason: 'redirect target already refreshed' })
      )
      report.processed.push(resultRecord(slug, { status: 'skipped' }))
      await emitProgress(slug, 'skipped')
      continue
    }
    const existing = policiesBySlug.get(slug) || []
    const printUrl = `${ORIGIN}/pal/${slug}/print-all`
    report.sources.policies.push(printUrl)
    const print = await get(printUrl)
    let pages = []
    let reason = ''
    let resolvedSlug = slug
    let incompleteFallback = false
    if (print.ok) {
      resolvedSlug = slugFromUrl(print.url) || slug
      try {
        pages = [extractPage(print.text, print.url, resolvedSlug)]
      } catch (error) {
        reason = brief(error)
      }
    } else reason = print.error || `HTTP ${print.status}`

    const canonicalUrls = [
      ...new Set(existing.map((policy) => policy.url).filter(Boolean)),
    ]
    if (!pages.length) {
      const canonicalResults = []
      for (const url of canonicalUrls.length
        ? canonicalUrls
        : [`${ORIGIN}/pal/${slug}`])
        canonicalResults.push(await get(url))
      const gone =
        !live.has(slug) &&
        existing.length > 0 &&
        [print, ...canonicalResults].every(
          (result) => result.status === 404 || result.status === 410
        )
      if (gone) {
        existing.forEach((policy) => retired.add(String(policy.id)))
        report.retired.push(
          resultRecord(slug, {
            ids: existing.map((policy) => String(policy.id)),
            sources: [printUrl, ...canonicalUrls],
          })
        )
        report.processed.push(resultRecord(slug, { status: 'retired' }))
        await emitProgress(slug, 'retired')
        continue
      }
      const queue = []
      for (const result of canonicalResults) {
        if (!result.ok) {
          incompleteFallback = true
          continue
        }
        try {
          const pageSlug = slugFromUrl(result.url) || slug
          if (pages.length && pageSlug !== resolvedSlug)
            throw new Error(`redirected to conflicting PAL slug ${pageSlug}`)
          resolvedSlug = pageSlug
          const page = extractPage(result.text, result.url, resolvedSlug)
          pages.push(page)
          queue.push(...page.links.map((link) => link.url))
        } catch (error) {
          incompleteFallback = true
          reason = brief(error)
        }
      }
      const fetched = new Set(canonicalResults.map((result) => result.url))
      for (const url of queue) {
        if (fetched.has(url)) continue
        fetched.add(url)
        const result = await get(url)
        if (!result.ok) {
          incompleteFallback = true
          reason = result.error || `HTTP ${result.status}`
          continue
        }
        try {
          const childSlug = slugFromUrl(result.url) || resolvedSlug
          if (childSlug !== resolvedSlug)
            throw new Error(`child redirected to different PAL slug ${childSlug}`)
          const page = extractPage(result.text, result.url, resolvedSlug)
          pages.push(page)
          for (const link of page.links)
            if (!fetched.has(link.url)) queue.push(link.url)
        } catch (error) {
          incompleteFallback = true
          reason = brief(error)
        }
      }
    }

    if (!pages.length || incompleteFallback) {
      if (existing.length) {
        existing.forEach((policy) => stale.add(String(policy.id)))
        report.stale.push(
          resultRecord(slug, {
            ids: existing.map((policy) => String(policy.id)),
            source: printUrl,
            error: reason,
          })
        )
        report.processed.push(resultRecord(slug, { status: 'stale' }))
      } else {
        report.failed.push(resultRecord(slug, { source: printUrl, error: reason }))
        report.processed.push(resultRecord(slug, { status: 'failed' }))
      }
      await emitProgress(slug, existing.length ? 'stale' : 'failed')
      continue
    }

    const fresh = combinePages(pages)
    if (!fresh.body.some(Boolean) || !fresh.chunks.length) {
      const error = 'page had no searchable policy text'
      if (existing.length) {
        existing.forEach((policy) => stale.add(String(policy.id)))
        report.stale.push(
          resultRecord(slug, {
            ids: existing.map((policy) => String(policy.id)),
            source: printUrl,
            error,
          })
        )
      } else report.failed.push(resultRecord(slug, { source: printUrl, error }))
      report.processed.push(
        resultRecord(slug, { status: existing.length ? 'stale' : 'failed' })
      )
      await emitProgress(slug, existing.length ? 'stale' : 'failed')
      continue
    }

    if (resolvedSlug !== slug) claimedLiveSlugs.add(resolvedSlug)
    const pageShape = tabsAndChapters(fresh.links, resolvedSlug)
    if (existing.length) {
      const topId = topLevelId(existing, slug, fresh.title)
      const group = existing.map((policy) => {
        const curated = { ...policy }
        delete curated.tabs
        delete curated.chapters
        delete curated.resources
        return {
          ...curated,
          title: String(policy.id) === topId ? fresh.title : policy.title,
          summary: fresh.summary,
          url: relocatedPolicyUrl(policy, slug, resolvedSlug, fresh, topId),
          ...(fresh.resources.length ? { resources: fresh.resources } : {}),
          ...pageShape,
        }
      })
      replacements.set(slug, { policies: group, fresh })
      report.updated.push(
        resultRecord(slug, {
          ids: group.map((policy) => String(policy.id)),
          source: printUrl,
        })
      )
    } else {
      const id = stableId(slug, usedIds)
      usedIds.add(String(id))
      const policy = {
        id,
        title: fresh.title,
        category: 'Other policies',
        tags: [],
        summary: fresh.summary,
        url: fresh.canonicalUrl || `${ORIGIN}/pal/${resolvedSlug}`,
        ...(fresh.resources.length ? { resources: fresh.resources } : {}),
        ...pageShape,
      }
      additions.push({ slug, policy, fresh })
      report.added.push(resultRecord(slug, { id: String(id), source: printUrl }))
    }
    report.processed.push(
      resultRecord(slug, { status: existing.length ? 'updated' : 'added' })
    )
    await emitProgress(slug, existing.length ? 'updated' : 'added')
  }

  const policies = old.policies
    .flatMap((policy) => {
      if (retired.has(String(policy.id))) return []
      const slug = slugFromUrl(policy.url)
      const replacement = replacements.get(slug)
      if (!replacement) return [policy]
      const freshPolicy = replacement.policies.find(
        (item) => String(item.id) === String(policy.id)
      )
      return freshPolicy ? [freshPolicy] : [policy]
    })
    .concat(additions.map((item) => item.policy))
  const categories = [...old.categories]
  if (additions.length && !categories.includes('Other policies'))
    categories.push('Other policies')
  const bodies = clone(old.bodies || {})
  const sections = clone(old.sections || {})
  let corpus = clone(old.corpus || [])
  for (const { policies: group, fresh } of replacements.values()) {
    for (const policy of group) {
      const id = String(policy.id)
      bodies[id] = fresh.body.join(' ')
      sections[id] = fresh.sections
      corpus = corpus.filter((chunk) => String(chunk.policyId) !== id)
      corpus.push(
        ...fresh.chunks.map((chunk) => ({
          policyId: id,
          policyTitle: policy.title,
          category: policy.category,
          ...chunk,
        }))
      )
    }
  }
  for (const { policy, fresh } of additions) {
    const id = String(policy.id)
    bodies[id] = fresh.body.join(' ')
    sections[id] = fresh.sections
    corpus.push(
      ...fresh.chunks.map((chunk) => ({
        policyId: id,
        policyTitle: policy.title,
        category: policy.category,
        ...chunk,
      }))
    )
  }
  for (const id of retired) {
    delete bodies[id]
    delete sections[id]
    corpus = corpus.filter((chunk) => String(chunk.policyId) !== id)
  }

  const production = old.policies.length >= 400 && limit === null
  const failures = report.failed.length + report.stale.length
  if (
    production &&
    (failures / Math.max(selected.length, 1) > 0.05 ||
      policies.length < old.policies.length * 0.9 ||
      policies.length < 400)
  )
    throw new Error(
      `PAL refresh rejected: ${failures}/${selected.length} failed or stale; ${policies.length} policies would remain`
    )

  const instant = now()
  const generatedAt =
    instant instanceof Date ? instant.toISOString() : new Date(instant).toISOString()
  const version = generatedAt.replace(/\D/g, '').slice(0, 14)
  const refreshedIds = new Set([
    ...[...replacements.values()].flatMap(({ policies: group }) =>
      group.map((policy) => String(policy.id))
    ),
    ...additions.map(({ policy }) => String(policy.id)),
  ])
  const dataset = {
    ...old,
    schemaVersion: 1,
    version: limit === null ? version : old.version,
    generatedAt: limit === null ? generatedAt : old.generatedAt,
    linksVerified: limit === null ? null : old.linksVerified,
    policies,
    categories,
    suggestions: old.suggestions,
    bodies,
    sections,
    corpus,
    stalePolicyIds: [
      ...new Set([
        ...old.stalePolicyIds.filter(
          (id) => !retired.has(String(id)) && !refreshedIds.has(String(id))
        ),
        ...stale,
      ]),
    ].sort(),
  }
  return { dataset, report }
}

export const __test = {
  decodeEntities,
  extractPage,
  sitemapSlugs,
  slugFromUrl,
  stableId,
}
