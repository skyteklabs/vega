import type { On, SessionUsage } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

type World = { fetched: string[]; logs: string[]; toasts: string[]; usageReads: number }

/** The engine beneath burner: the session costs `usd`, and the exchange-rate API answers `reply`. */
function engine(on: On, opts: { usd: number; reply?: object; sessionId?: string; fetchThrows?: boolean; usageFails?: boolean }): World {
  const w: World = { fetched: [], logs: [], toasts: [], usageReads: 0 }
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }))
  on('session.id', () => ({ value: opts.sessionId ?? 's1' }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('session.usage', () => (w.usageReads++, opts.usageFails) ? { deny: 'usage unavailable' } : ({ value: { startedAt: 0, context: {} as never, rateLimits: [], cost: { usd: opts.usd } } satisfies SessionUsage }))
  on('http.fetch', (_$, e) => {
    w.fetched.push(e.url)
    if (opts.fetchThrows) return { deny: `connect ECONNREFUSED while fetching ${e.url}` }
    const text = JSON.stringify(opts.reply ?? { result: 'error', 'error-type': 'invalid-key' })
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  return w
}

const rate = (idr: number) => ({ result: 'success', base_code: 'USD', conversion_rates: { USD: 1, IDR: idr } })

const band = {
  plugin: 'burner',
  component: 'AbovePrompt' as const,
  surface: 'terminal' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 80, scroll: { offset: 0, bodyRows: 12 }, view: {} },
}

/** A session started and run long enough for the odometer to land (and short of the six-second rotation). */
async function start($: Engine, clock: MockClock) {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(3000)
}

/** The comparison the band shows. */
async function comparison($: Engine) {
  const ui = await $.ui.mount(band)
  return (await ui.find({ text: /porsi nasi padang/ }))?.text.match(/= [\d,]+ porsi nasi padang/)?.[0]
}

test('with no key, the manual rate prices the foods and nothing is fetched', { options: { language: 'id', idrPerUsd: 20_000 } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  const w = engine(on, { usd: 2.5 })
  await start($, clock)
  expect(w.fetched).toEqual([])
  expect(await comparison($)).toBe('= 2,0 porsi nasi padang')
})

test('with a key, the live rate overrides the manual one', { options: { language: 'id', idrPerUsd: 20_000, exchangeRateApiKey: 'k1' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  const w = engine(on, { usd: 2.5, reply: rate(25_000) })
  await start($, clock)
  expect(w.fetched).toEqual(['https://v6.exchangerate-api.com/v6/k1/latest/USD'])
  expect(await comparison($)).toBe('= 2,5 porsi nasi padang')
})

test('the key can come from EXCHANGERATE_API_KEY', { options: { language: 'id' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, { EXCHANGERATE_API_KEY: 'from-env' })
  const w = engine(on, { usd: 2.5, reply: rate(25_000) })
  await start($, clock)
  expect(w.fetched).toEqual(['https://v6.exchangerate-api.com/v6/from-env/latest/USD'])
})

test('a rate cached for this session is reused without a request', { options: { language: 'id', exchangeRateApiKey: 'k1' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { fx: { sessionId: 's1', idrPerUsd: 25_000, fetchedAt: 0 } })
  mock.env(on, {})
  const w = engine(on, { usd: 2.5, reply: rate(99_999) })
  await start($, clock)
  expect(w.fetched).toEqual([])
  expect(await comparison($)).toBe('= 2,5 porsi nasi padang')
})

test('a new session fetches again', { options: { language: 'id', exchangeRateApiKey: 'k1' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { fx: { sessionId: 'old', idrPerUsd: 10_000, fetchedAt: 0 } })
  mock.env(on, {})
  const w = engine(on, { usd: 2.5, reply: rate(25_000), sessionId: 's2' })
  await start($, clock)
  expect(w.fetched).toHaveLength(1)
  expect(await comparison($)).toBe('= 2,5 porsi nasi padang')
})

test('a failed request falls back to the last cached rate, then to the manual one', { options: { language: 'id', idrPerUsd: 20_000, exchangeRateApiKey: 'bad' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { fx: { sessionId: 'old', idrPerUsd: 25_000, fetchedAt: 0 } })
  mock.env(on, {})
  const w = engine(on, { usd: 2.5 })
  await start($, clock)
  expect(w.fetched).toHaveLength(1)
  expect(w.logs.some(l => l.includes('invalid-key'))).toBe(true)
  expect(w.logs.some(l => l.includes('bad'))).toBe(false)
  expect(await comparison($)).toBe('= 2,5 porsi nasi padang')
})

test('a failed request with nothing cached keeps the manual rate', { options: { language: 'id', idrPerUsd: 20_000, exchangeRateApiKey: 'bad' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  engine(on, { usd: 2.5 })
  await start($, clock)
  expect(await comparison($)).toBe('= 2,0 porsi nasi padang')
})

test('with neither rupiah nor the Indonesian foods shown, no rate is fetched', { options: { language: 'en', exchangeRateApiKey: 'k1' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  const w = engine(on, { usd: 2.5, reply: rate(25_000) })
  await start($, clock)
  expect(w.fetched).toEqual([])
})

test('rupiah money alone fetches the rate, and the band shows it in rupiah', { options: { language: 'en', currency: 'idr', exchangeRateApiKey: 'k1' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  const w = engine(on, { usd: 2.5, reply: rate(16_000) })
  await start($, clock)
  expect(w.fetched).toHaveLength(1)
  const ui = await $.ui.mount(band)
  expect(await ui.find({ text: /Rp 40\.000 = / })).toBeDefined()
  expect(await ui.find({ text: /burrito/ })).toBeDefined()
})

test('by default the band is Indonesian and in rupiah', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  engine(on, { usd: 2.5 })
  await start($, clock)
  const ui = await $.ui.mount(band)
  expect(await ui.find({ text: /BAKAR/ })).toBeDefined()
  expect(await ui.find({ text: /Rp 40\.750 = / })).toBeDefined()
})

test('in rupiah, the alert names a round rupiah amount', { options: { idrPerUsd: 16_000 } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  const w = engine(on, { usd: 7 })
  await start($, clock)
  expect(w.toasts).toEqual(['Rp 100.000 terbakar sesi ini = 20 gelas es teh manis'])
})

test('in dollars, the alerts stay $1, $5, $10, $25, $50', { options: { language: 'en' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  const w = engine(on, { usd: 7 })
  await start($, clock)
  expect(w.toasts).toHaveLength(1)
  expect(w.toasts[0]).toMatch(/^\$5\.00 burned this session = /)
})

test('a request that throws never logs the key, even when the error quotes the URL', { options: { exchangeRateApiKey: 'secret-key' } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  const w = engine(on, { usd: 2.5, fetchThrows: true })
  await start($, clock)
  expect(w.fetched).toHaveLength(1)
  expect(w.logs.some(l => l.includes('exchange rate failed') && l.includes('/v6/***/latest/USD'))).toBe(true)
  expect(w.logs.some(l => l.includes('secret-key'))).toBe(false)
})

test('a resumed session does not replay the alerts it already fired', { options: { idrPerUsd: 16_000 } }, async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { 'fired:s1': [20_000, 50_000, 100_000] })
  mock.env(on, {})
  const w = engine(on, { usd: 7 })
  await start($, clock)
  expect(w.toasts).toEqual([])
})

/**
 * A store whose reads of `lifetime` wait until `release` is called, so two
 * cost readings can be caught in flight together.
 */
function slowStore(on: On, entries: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(entries))
  const writes: Array<[string, unknown]> = []
  let open: () => void = () => undefined
  let gate = new Promise<void>(resolve => (open = resolve))
  on('store.get', async (_$, e) => {
    if (e.key === 'lifetime') await gate
    return { value: data.get(e.key) }
  })
  on('store.set', (_$, e) => {
    data.set(e.key, e.value)
    writes.push([e.key, e.value])
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    data.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...data.keys()] }))
  return {
    data,
    writes,
    release: () => {
      open()
      gate = Promise.resolve()
    },
  }
}

test('readings caught in flight together count the session once', { options: { idrPerUsd: 16_000 } }, async ($, on) => {
  const clock = mock.clock(on)
  const store = slowStore(on)
  mock.env(on, {})
  engine(on, { usd: 2 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // The first reading is held on the lifetime read; the timer and a finished turn ask for more.
  await clock.advance(1000)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
  await clock.advance(1000)
  store.release()
  await clock.settle()
  await clock.advance(3000)
  expect(store.data.get('lifetime')).toBe(2)
  expect(store.writes.filter(([k]) => k === 'lifetime')).toEqual([['lifetime', 2]])
})

test('a reading that hangs does not hold a finished turn', { options: { idrPerUsd: 16_000 } }, async ($, on) => {
  const clock = mock.clock(on)
  slowStore(on)
  mock.env(on, {})
  engine(on, { usd: 2 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const done = await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })
  expect(done).toBeDefined()
})

test('the store keeps the last 100 sessions and deletes the keys of older ones', async ($, on) => {
  const clock = mock.clock(on)
  const ids = Array.from({ length: 100 }, (_, i) => `old${i}`)
  const store = slowStore(on, { sessions: ids, 'last:old0': { sessionId: 'old0', usd: 1 }, 'fired:old0': [1], 'last:old1': { sessionId: 'old1', usd: 1 } })
  store.release()
  mock.env(on, {})
  engine(on, { usd: 0.5, sessionId: 'new' })
  await start($, clock)
  expect((store.data.get('sessions') as string[]).length).toBe(100)
  expect((store.data.get('sessions') as string[]).at(-1)).toBe('new')
  expect(store.data.has('last:old0')).toBe(false)
  expect(store.data.has('fired:old0')).toBe(false)
  expect(store.data.has('last:old1')).toBe(true)
})

test('a cached rate older than 30 days is not fallen back on', { options: { language: 'id', idrPerUsd: 20_000, exchangeRateApiKey: 'bad-key-123' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 40 * 24 * 60 * 60 * 1000 })
  mock.store(on, { fx: { sessionId: 'old', idrPerUsd: 25_000, fetchedAt: 0 } })
  mock.env(on, {})
  engine(on, { usd: 2.5 })
  await start($, clock)
  expect(await comparison($)).toBe('= 2,0 porsi nasi padang')
})

test('a failing cost reading is logged once', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on)
  mock.env(on, {})
  const w = engine(on, { usd: 1, usageFails: true })
  await start($, clock)
  expect(w.logs.filter(l => l.startsWith('[burner] cost reading failed')).length).toBe(1)
})

test('a held reading does not pile up a backlog from the timer', { options: { idrPerUsd: 16_000 } }, async ($, on) => {
  const clock = mock.clock(on)
  const store = slowStore(on)
  mock.env(on, {})
  const w = engine(on, { usd: 2 })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Five ticks while the first reading is held: they join one queued reading.
  await clock.advance(5000)
  const before = w.usageReads
  store.release()
  await clock.settle()
  expect(w.usageReads - before).toBe(1)
})
