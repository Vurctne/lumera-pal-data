import assert from 'node:assert/strict'
import test from 'node:test'
import { refreshDataset, sanitizeDatasetNavigationLinks } from './refresh.mjs'

const ORIGIN = 'https://www2.education.vic.gov.au'

function response(status, body = '', headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  }
}

function fakeFetch(routes) {
  const calls = []
  const fetch = async (url) => {
    calls.push(String(url))
    const route = routes[String(url)]
    if (Array.isArray(route)) {
      const next = route.shift()
      if (next) return next
    }
    if (route) return route
    throw new Error(`unexpected request: ${url}`)
  }
  fetch.calls = calls
  return fetch
}

function sitemap(...urls) {
  return `<?xml version="1.0"?><urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`
}

function page({
  title = 'Official Policy',
  summary = 'Fresh &amp; accurate summary.',
  body = 'New body &#x2014; shorter.',
  links = '',
  duplicate = false,
} = {}) {
  return `<!doctype html><html><head><meta name="description" content="Meta fallback"></head><body>
    <header><h1>${title}</h1></header>
    <main><nav><h2 id="fake-nav">On this page</h2></nav>
      ${links}
      <h2 id="summary">Summary</h2><p>${summary}</p>
      <h3 id="requirements">Requirements &amp; duties</h3><p>${body}</p>
      ${duplicate ? '<h3 id="requirements">Duplicate must be ignored</h3><p>wrong duplicate</p>' : ''}
      <h2 id="resources">Resources</h2>
      <p><a href="https://files.example.gov.au/guide.pdf">Current guide</a>
      <a href="mailto:team@example.gov.au">Email team</a><a href="::::">Broken</a></p>
      <aside><h2 id="fake-aside">Aside</h2></aside>
    </main><footer>footer</footer></body></html>`
}

function previous(policy = {}) {
  const base = {
    id: 7,
    title: 'Old title',
    category: 'Operations',
    tags: ['curated', 'keep-me'],
    summary: 'Old summary with stale amount $99',
    url: `${ORIGIN}/pal/alpha/policy`,
    chapters: [{ title: 'Old amount $99', url: `${ORIGIN}/pal/alpha/policy#old` }],
  }
  const finalPolicy = { ...base, ...policy }
  const id = String(finalPolicy.id)
  return {
    schemaVersion: 1,
    version: '20260901000000',
    generatedAt: '2026-09-01T00:00:00.000Z',
    linksVerified: '2026-09-01',
    policies: [finalPolicy],
    categories: ['Operations'],
    suggestions: ['old suggestion'],
    bodies: { [id]: 'OLD BODY LONGER THAN THE REPLACEMENT' },
    sections: { [id]: [{ heading: 'Old', url: `${ORIGIN}/pal/alpha/policy#old` }] },
    corpus: [
      {
        policyId: id,
        policyTitle: base.title,
        category: base.category,
        heading: 'Old',
        url: base.url,
        text: 'OLD CORPUS',
      },
    ],
    stalePolicyIds: [],
  }
}

test('replaces body, sections, corpus, summary and stale generated chapters with current public HTML', async () => {
  const print = `${ORIGIN}/pal/alpha/print-all`
  const html = page({
    title: 'Official &amp; Current',
    links: `<a href="/pal/alpha/policy">Policy</a>
      <a href="/pal/alpha/guidance/chapter-one">Chapter One</a>
      <a href="/pal/alpha/files/money.pdf">Attachment</a>
      <a href="/pal/beta/policy">Another policy</a>
      <a href="https://example.com/pal/alpha/chapter">External</a>`,
    duplicate: true,
  })
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/alpha/policy`)),
    [print]: response(200, html),
  })
  const { dataset, report } = await refreshDataset(previous(), {
    fetchImpl: fetch,
    delayMs: 0,
    now: () => new Date('2026-10-02T20:21:22.000Z'),
  })

  assert.equal(dataset.version, '20261002202122')
  assert.equal(dataset.linksVerified, null)
  assert.equal(dataset.policies[0].title, 'Official & Current')
  assert.deepEqual(dataset.policies[0].tags, ['curated', 'keep-me'])
  assert.equal(dataset.policies[0].summary, 'Fresh & accurate summary.')
  assert.ok(!dataset.bodies['7'].includes('OLD BODY'))
  assert.ok(dataset.bodies['7'].includes('New body — shorter.'))
  assert.equal(
    dataset.sections['7'].filter((item) => item.heading === 'Requirements & duties')
      .length,
    1
  )
  assert.equal(
    dataset.corpus.filter(
      (item) => item.policyId === '7' && item.heading === 'Requirements & duties'
    ).length,
    1
  )
  assert.deepEqual(dataset.policies[0].chapters, [
    { title: 'Chapter One', url: `${ORIGIN}/pal/alpha/guidance/chapter-one` },
  ])
  assert.deepEqual(dataset.policies[0].resources, [
    { title: 'Current guide', url: 'https://files.example.gov.au/guide.pdf' },
  ])
  assert.equal(report.updated.length, 1)
})

test('real-shaped skip and print-all links never become chapters', async () => {
  const print = `${ORIGIN}/pal/alpha/print-all`
  const html = `<!doctype html><html><body>
    <a href="#rpl-main">Skip to main content</a>
    <header><h1>Alpha Policy</h1><a href="${print}">Print whole topic</a></header>
    <main id="rpl-main">
      <a href="${print}">Skip to main content</a>
      <a href="/pal/alpha/guidance/real-chapter">Real chapter</a>
      <h2 id="summary">Summary</h2><p>Schools follow the current policy requirements.</p>
      <h2 id="real-section">Real section</h2><p>This section remains searchable and linked.</p>
    </main>
  </body></html>`
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/alpha/policy`)),
    [print]: response(200, html),
  })
  const { dataset } = await refreshDataset(previous(), { fetchImpl: fetch, delayMs: 0 })
  assert.deepEqual(dataset.policies[0].chapters, [
    { title: 'Real chapter', url: `${ORIGIN}/pal/alpha/guidance/real-chapter` },
  ])
  assert.equal(
    dataset.sections['7'].some((section) => section.heading === 'Real section'),
    true
  )
})

test('sanitizeDatasetNavigationLinks repairs a fetched dataset without touching real chapters', () => {
  const fetched = previous({
    chapters: [
      { title: 'Skip to main content', url: `${ORIGIN}/pal/alpha/print-all` },
      { title: 'Print whole topic', url: `${ORIGIN}/pal/alpha/print-all` },
      { title: 'Real chapter', url: `${ORIGIN}/pal/alpha/guidance/real-chapter` },
    ],
  })
  const cleaned = sanitizeDatasetNavigationLinks(fetched)
  assert.deepEqual(cleaned.policies[0].chapters, [
    { title: 'Real chapter', url: `${ORIGIN}/pal/alpha/guidance/real-chapter` },
  ])
  assert.equal(fetched.policies[0].chapters.length, 3)
  assert.equal(cleaned.bodies, fetched.bodies)
  assert.equal(cleaned.sections, fetched.sections)
  assert.equal(cleaned.corpus, fetched.corpus)
})

test('a failed policy preserves its complete old policy and all three derived stores', async () => {
  const old = previous()
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/alpha/policy`)),
    [`${ORIGIN}/pal/alpha/print-all`]: [response(500), response(500)],
    [`${ORIGIN}/pal/alpha/policy`]: [response(503), response(503)],
  })
  const { dataset, report } = await refreshDataset(old, {
    fetchImpl: fetch,
    delayMs: 0,
  })
  assert.deepEqual(dataset.policies, old.policies)
  assert.deepEqual(dataset.bodies, old.bodies)
  assert.deepEqual(dataset.sections, old.sections)
  assert.deepEqual(dataset.corpus, old.corpus)
  assert.deepEqual(dataset.stalePolicyIds, ['7'])
  assert.equal(report.stale.length, 1)
})

test('maintenance HTML is failure and a 403 aborts the whole refresh', async () => {
  const maintenance =
    '<html><head><title>Maintenance</title></head><body><h1>Maintenance</h1><main><h2 id="notice">Temporarily unavailable</h2></main></body></html>'
  const maintenanceFetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/alpha/policy`)),
    [`${ORIGIN}/pal/alpha/print-all`]: response(200, maintenance),
    [`${ORIGIN}/pal/alpha/policy`]: response(200, maintenance),
  })
  const result = await refreshDataset(previous(), {
    fetchImpl: maintenanceFetch,
    delayMs: 0,
  })
  assert.equal(result.report.stale.length, 1)
  assert.equal(result.dataset.bodies['7'], 'OLD BODY LONGER THAN THE REPLACEMENT')

  const forbiddenFetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/alpha/policy`)),
    [`${ORIGIN}/pal/alpha/print-all`]: response(403),
  })
  await assert.rejects(
    refreshDataset(previous(), { fetchImpl: forbiddenFetch, delayMs: 0 }),
    /HTTP 403/
  )
  assert.equal(forbiddenFetch.calls.length, 2)
})

test('a new policy gets a deterministic collision-safe numeric id and Other policies category', async () => {
  const betaPrint = `${ORIGIN}/pal/beta/print-all`
  const routes = {
    [`${ORIGIN}/sitemap.xml`]: response(
      200,
      sitemap(
        `${ORIGIN}/pal/alpha/policy`,
        `${ORIGIN}/pal/beta/policy`,
        `${ORIGIN}/pal/about-pal`,
        `${ORIGIN}/pal/a-test-policy`
      )
    ),
    [`${ORIGIN}/pal/alpha/print-all`]: response(200, page({ title: 'Alpha' })),
    [betaPrint]: response(200, page({ title: 'Brand New Policy' })),
  }
  const first = await refreshDataset(previous(), {
    fetchImpl: fakeFetch(structuredCloneRoutes(routes)),
    delayMs: 0,
  })
  const second = await refreshDataset(previous(), {
    fetchImpl: fakeFetch(structuredCloneRoutes(routes)),
    delayMs: 0,
  })
  const a = first.dataset.policies.find((policy) => policy.title === 'Brand New Policy')
  const b = second.dataset.policies.find(
    (policy) => policy.title === 'Brand New Policy'
  )
  assert.equal(typeof a.id, 'number')
  assert.equal(a.id, b.id)
  assert.equal(a.category, 'Other policies')
  assert.ok(first.dataset.categories.includes('Other policies'))
  assert.deepEqual(
    first.report.added.map((item) => item.slug),
    ['beta']
  )
})

test('sitemap absence alone does not retire; print-all and original canonical must both be 404/410', async () => {
  const retainedFetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap()),
    [`${ORIGIN}/pal/alpha/print-all`]: response(404),
    [`${ORIGIN}/pal/alpha/policy`]: response(200, page({ title: 'Still Live' })),
  })
  const retained = await refreshDataset(previous(), {
    fetchImpl: retainedFetch,
    delayMs: 0,
  })
  assert.equal(retained.dataset.policies.length, 1)
  assert.equal(retained.report.retired.length, 0)

  const goneFetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap()),
    [`${ORIGIN}/pal/alpha/print-all`]: response(404),
    [`${ORIGIN}/pal/alpha/policy`]: response(410),
  })
  const gone = await refreshDataset(previous(), { fetchImpl: goneFetch, delayMs: 0 })
  assert.equal(gone.dataset.policies.length, 0)
  assert.deepEqual(gone.dataset.bodies, {})
  assert.deepEqual(gone.dataset.sections, {})
  assert.deepEqual(gone.dataset.corpus, [])
  assert.equal(gone.report.retired.length, 1)
})

test('limit marks output partial and cannot claim fresh metadata', async () => {
  const old = previous()
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(
      200,
      sitemap(`${ORIGIN}/pal/alpha/policy`, `${ORIGIN}/pal/beta/policy`)
    ),
    [`${ORIGIN}/pal/alpha/print-all`]: response(200, page({ title: 'Alpha Current' })),
  })
  const { dataset, report } = await refreshDataset(old, {
    fetchImpl: fetch,
    delayMs: 0,
    limit: 1,
    now: () => new Date('2030-01-01T00:00:00Z'),
  })
  assert.equal(report.partial, true)
  assert.equal(report.skipped.length, 1)
  assert.equal(dataset.version, old.version)
  assert.equal(dataset.generatedAt, old.generatedAt)
  assert.equal(dataset.linksVerified, old.linksVerified)
})

test('shared-slug curated entries keep their own identity while sharing refreshed content', async () => {
  const old = previous()
  old.policies.push({
    id: 8,
    title: 'Alpha — Curated Chapter',
    category: 'Finance',
    tags: ['chapter-tag'],
    summary: 'Old chapter summary',
    url: `${ORIGIN}/pal/alpha/guidance/chapter-one`,
  })
  old.categories.push('Finance')
  old.bodies['8'] = 'OLD CHAPTER BODY'
  old.sections['8'] = []
  old.corpus.push({
    policyId: '8',
    policyTitle: 'Alpha — Curated Chapter',
    category: 'Finance',
    heading: 'Old',
    url: old.policies[1].url,
    text: 'old',
  })
  old.stalePolicyIds = ['7', '8']
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/alpha/policy`)),
    [`${ORIGIN}/pal/alpha/print-all`]: response(
      200,
      page({ title: 'Alpha Official Name' })
    ),
  })
  const { dataset } = await refreshDataset(old, { fetchImpl: fetch, delayMs: 0 })
  assert.equal(
    dataset.policies.find((policy) => policy.id === 7).title,
    'Alpha Official Name'
  )
  assert.equal(
    dataset.policies.find((policy) => policy.id === 8).title,
    'Alpha — Curated Chapter'
  )
  assert.equal(dataset.policies.find((policy) => policy.id === 8).category, 'Finance')
  assert.deepEqual(dataset.policies.find((policy) => policy.id === 8).tags, [
    'chapter-tag',
  ])
  assert.equal(dataset.bodies['7'], dataset.bodies['8'])
  assert.equal(
    dataset.corpus.some(
      (item) => item.policyId === '8' && item.policyTitle === 'Alpha — Curated Chapter'
    ),
    true
  )
  assert.deepEqual(dataset.stalePolicyIds, [])
})

test('never follows a redirect away from the official PAL host', async () => {
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/alpha/policy`)),
    [`${ORIGIN}/pal/alpha/print-all`]: response(302, '', {
      location: 'https://example.com/copied-page',
    }),
    [`${ORIGIN}/pal/alpha/policy`]: response(302, '', {
      location: 'https://example.com/copied-page',
    }),
  })
  const { dataset, report } = await refreshDataset(previous(), {
    fetchImpl: fetch,
    delayMs: 0,
  })
  assert.equal(
    fetch.calls.some((url) => url.startsWith('https://example.com/')),
    false
  )
  assert.equal(report.stale.length, 1)
  assert.equal(dataset.bodies['7'], 'OLD BODY LONGER THAN THE REPLACEMENT')
})

test('a failed discovered fallback chapter makes the entire old policy stale', async () => {
  const canonical = `${ORIGIN}/pal/alpha/policy`
  const child = `${ORIGIN}/pal/alpha/guidance/chapter-one`
  const canonicalHtml = page({ links: `<a href="${child}">Chapter One</a>` })
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(canonical, child)),
    [`${ORIGIN}/pal/alpha/print-all`]: response(404),
    [canonical]: response(200, canonicalHtml),
    [child]: [response(500), response(500)],
  })
  const old = previous()
  const { dataset, report } = await refreshDataset(old, {
    fetchImpl: fetch,
    delayMs: 0,
  })
  assert.equal(report.stale.length, 1)
  assert.deepEqual(dataset.policies, old.policies)
  assert.deepEqual(dataset.bodies, old.bodies)
  assert.deepEqual(dataset.sections, old.sections)
  assert.deepEqual(dataset.corpus, old.corpus)
})

test('body-only pages still emit a non-empty searchable corpus chunk', async () => {
  const bodyOnly =
    '<html><body><h1>Body Only</h1><main><p>Searchable source text &#169; Department.</p></main></body></html>'
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/alpha`)),
    [`${ORIGIN}/pal/alpha/print-all`]: response(200, bodyOnly),
  })
  const { dataset } = await refreshDataset(previous(), { fetchImpl: fetch, delayMs: 0 })
  const chunks = dataset.corpus.filter((chunk) => chunk.policyId === '7')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].heading, 'Body Only')
  assert.equal(chunks[0].text, 'Searchable source text © Department.')
  assert.deepEqual(dataset.sections['7'], [])
})

test('a short Summary lead includes its following source list', async () => {
  const parentContributions = `<html><body><h1>Parent Contributions</h1><main>
    <h2 id="summary">Summary</h2>
    <p>Schools must:</p>
    <ul><li>provide students with free instruction</li><li>follow the parent payment arrangements</li></ul>
    <h2 id="policy">Policy</h2><p>This policy explains the requirements for parent contributions.</p>
  </main></body></html>`
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/alpha/policy`)),
    [`${ORIGIN}/pal/alpha/print-all`]: response(200, parentContributions),
  })
  const { dataset } = await refreshDataset(previous(), { fetchImpl: fetch, delayMs: 0 })
  assert.equal(
    dataset.policies[0].summary,
    'Schools must: provide students with free instruction follow the parent payment arrangements'
  )
})

test('without Summary or meta description, summary starts from substantive Overview text', async () => {
  const overview = `<html><body><h1>Overview Policy</h1><main>
    <section><h2>Policy last updated</h2><p>30 September 2026</p><h2>Scope</h2><p>Schools</p><p>Date: 2 October 2026</p></section>
    <h2 id="overview">Overview</h2><p>This policy sets out how schools support students and document the support they provide.</p>
    <h2 id="related-policies">Related policies</h2><p>Another policy with enough words to otherwise look substantive.</p>
    <h2 id="resources">Resources</h2><p>Forms and templates are available from the department.</p>
  </main></body></html>`
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/alpha/policy`)),
    [`${ORIGIN}/pal/alpha/print-all`]: response(200, overview),
  })
  const { dataset } = await refreshDataset(previous(), { fetchImpl: fetch, delayMs: 0 })
  assert.equal(
    dataset.policies[0].summary,
    'This policy sets out how schools support students and document the support they provide.'
  )
  assert.equal(dataset.policies[0].summary.includes('Policy last updated'), false)
})

test('oversize responses are rejected without publishing partial content', async () => {
  const oversized = response(200, '', { 'content-length': String(8 * 1024 * 1024 + 1) })
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/alpha/policy`)),
    [`${ORIGIN}/pal/alpha/print-all`]: [oversized, oversized],
    [`${ORIGIN}/pal/alpha/policy`]: [oversized, oversized],
  })
  const old = previous()
  const { dataset, report } = await refreshDataset(old, {
    fetchImpl: fetch,
    delayMs: 0,
  })
  assert.equal(report.stale.length, 1)
  assert.deepEqual(dataset.bodies, old.bodies)
})

test('same-host renamed slug updates canonical URLs and reports progress for every selected policy', async () => {
  const progress = []
  const renamedPrint = `${ORIGIN}/pal/renamed/print-all`
  const fetch = fakeFetch({
    [`${ORIGIN}/sitemap.xml`]: response(200, sitemap(`${ORIGIN}/pal/renamed/policy`)),
    [`${ORIGIN}/pal/alpha/print-all`]: response(301, '', { location: renamedPrint }),
    [renamedPrint]: response(200, page({ title: 'Renamed Policy' })),
  })
  const { dataset, report } = await refreshDataset(previous(), {
    fetchImpl: fetch,
    delayMs: 0,
    onProgress: (event) => progress.push(event),
  })
  assert.equal(dataset.policies.length, 1)
  assert.equal(dataset.policies[0].url, `${ORIGIN}/pal/renamed`)
  assert.equal(
    dataset.sections['7'].every((section) =>
      section.url.startsWith(`${renamedPrint}#`)
    ),
    true
  )
  assert.deepEqual(
    progress.map(({ completed, total, slug, status }) => ({
      completed,
      total,
      slug,
      status,
    })),
    [
      { completed: 1, total: 2, slug: 'alpha', status: 'updated' },
      { completed: 2, total: 2, slug: 'renamed', status: 'skipped' },
    ]
  )
  assert.equal(report.added.length, 0)
})

function structuredCloneRoutes(routes) {
  return Object.fromEntries(
    Object.entries(routes).map(([key, value]) => [
      key,
      { ...value, headers: value.headers },
    ])
  )
}
