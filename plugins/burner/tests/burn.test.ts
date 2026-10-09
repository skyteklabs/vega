import { describe, expect, test } from 'claude-code/testing'

import { FIRE_ROWS, IDR_PER_USD, THINGS, THINGS_ID, TEXT, barText, compare, crossed, fireCells, thresholds, heat, lifetimeDelta, modelName, modelsLine, money, pct, fxUrl, needsRate, rateError, readRate, redact, resetsIn, isFresh, FX_STALE_MS, keepRecent, SESSIONS_KEPT, settings, tallyTurn, thingsId, tokenCount, tween, windows, withRate } from '../hooks/burn'

describe('burn math', () => {
  test('money formats cents and fractions of a cent', async () => {
    expect(money(0)).toBe('$0.00')
    expect(money(12.345)).toBe('$12.35')
    expect(money(0.0042)).toBe('$0.0042')
    expect(money(0, 'idr')).toBe('Rp 0')
    expect(money(4.25, 'idr', 16_300)).toBe('Rp 69.275')
    expect(money(61.08, 'idr', 16_300)).toBe('Rp 995.604')
    expect(money(100, 'idr', 16_300)).toBe('Rp 1.630.000')
    expect(money(0.0004, 'idr', 16_300)).toBe('Rp 6,52')
    expect(money(0.001, 'idr', 16_300)).toBe('Rp 16')
  })

  test('comparisons pick a thing and pluralize', async () => {
    expect(compare(22, 0)).toBe('= 2.0 burritos')
    expect(compare(11, 0)).toBe('= 1.0 burrito')
    expect(compare(3.19, 1)).toBe('= 1.0 McDouble')
    expect(compare(31.9, 1)).toBe('= 10 McDoubles')
    expect(compare(11, 2)).toBe('= 1.0 burrito')
  })

  test('Indonesian comparisons use a decimal comma and no plural', async () => {
    const padang = THINGS_ID[0]!.usd
    expect(compare(padang, 0, THINGS_ID, 'id')).toBe('= 1,0 porsi nasi padang')
    expect(compare(padang * 2.5, 0, THINGS_ID, 'id')).toBe('= 2,5 porsi nasi padang')
    expect(compare(padang * 12, 0, THINGS_ID, 'id')).toBe('= 12 porsi nasi padang')
    expect(compare(THINGS_ID[2]!.usd * 3, 5, THINGS_ID, 'id')).toBe('= 3,0 gelas es teh manis')
    expect(compare(22, 0, THINGS, 'id')).toBe('= 2,0 burritos')
  })

  test('options pick the language and the things, auto following the language', async () => {
    expect(settings()).toEqual({ lang: 'id', text: TEXT.id, set: 'id', currency: 'idr', apiKey: '', idrPerUsd: IDR_PER_USD, things: THINGS_ID })
    expect(settings({ language: 'en' })).toEqual({ lang: 'en', text: TEXT.en, set: 'us', currency: 'usd', apiKey: '', idrPerUsd: IDR_PER_USD, things: THINGS })
    expect(settings({ language: 'id', comparisons: 'us' }).things).toBe(THINGS)
    expect(settings({ language: 'en', comparisons: 'id' }).things).toEqual(THINGS_ID)
    expect(settings({ language: 'fr', comparisons: 'auto', currency: 'auto' })).toMatchObject({ lang: 'id', currency: 'idr' })
    expect(settings({ language: 'id', currency: 'usd' }).currency).toBe('usd')
    expect(settings({ language: 'en', currency: 'idr' }).currency).toBe('idr')
    expect(needsRate(settings({ language: 'en' }))).toBe(false)
    expect(needsRate(settings({ language: 'en', currency: 'idr' }))).toBe(true)
    expect(needsRate(settings({ language: 'id', comparisons: 'us' }))).toBe(true)
  })

  test('the rupiah rate: manual, live, and malformed replies', async () => {
    expect(settings({ comparisons: 'id', idrPerUsd: 20_000 }).things[0]!.usd).toBe(1.25)
    expect(settings({ idrPerUsd: -5 }).idrPerUsd).toBe(IDR_PER_USD)
    expect(settings({ exchangeRateApiKey: '  k1 ' }).apiKey).toBe('k1')
    expect(withRate(settings({ comparisons: 'id' }), 25_000).things[0]!.usd).toBe(1)
    expect(withRate(settings({ comparisons: 'us' }), 25_000).things).toBe(THINGS)
    expect(thingsId(5_000).map(t => t.usd)).toEqual([5, 4, 1])
    expect(fxUrl('a/b')).toBe('https://v6.exchangerate-api.com/v6/a%2Fb/latest/USD')
    expect(readRate(JSON.stringify({ result: 'success', conversion_rates: { USD: 1, IDR: 16_412.5 } }))).toBe(16_412.5)
    expect(readRate(JSON.stringify({ result: 'error', 'error-type': 'quota-reached' }))).toBe(null)
    expect(readRate(JSON.stringify({ result: 'success', conversion_rates: { IDR: 0 } }))).toBe(null)
    expect(readRate('<html>')).toBe(null)
    expect(rateError(JSON.stringify({ result: 'error', 'error-type': 'quota-reached' }))).toBe('quota-reached')
    expect(rateError('<html>')).toBe('')
    expect(redact('GET https://v6.exchangerate-api.com/v6/k%2F1/latest/USD failed', 'k/1')).toBe('GET https://v6.exchangerate-api.com/v6/***/latest/USD failed')
    expect(redact('key abcdefgh and abcdefgh', 'abcdefgh')).toBe('key *** and ***')
    expect(redact('a bad /v6/a/latest/USD request', 'a')).toBe('a bad /v6/***/latest/USD request')
    expect(redact('GET /v6/whatever-it-is/latest/USD', '')).toBe('GET /v6/***/latest/USD')
  })

  test('cached rates go stale after 30 days', async () => {
    expect(isFresh(0, FX_STALE_MS)).toBe(true)
    expect(isFresh(0, FX_STALE_MS + 1)).toBe(false)
    expect(isFresh(undefined, 0)).toBe(false)
  })

  test('the store keeps the most recent sessions, the resumed one moved to the end', async () => {
    expect(keepRecent([], 's1', 3)).toEqual({ kept: ['s1'], dropped: [] })
    expect(keepRecent(['a', 'b', 'c'], 'd', 3)).toEqual({ kept: ['b', 'c', 'd'], dropped: ['a'] })
    expect(keepRecent(['a', 'b', 'c'], 'a', 3)).toEqual({ kept: ['b', 'c', 'a'], dropped: [] })
    expect(SESSIONS_KEPT).toBe(100)
    expect(redact('nothing to hide', '')).toBe('nothing to hide')
  })

  test('every language has every line', async () => {
    expect(Object.keys(TEXT.id).sort()).toEqual(Object.keys(TEXT.en).sort())
    expect(TEXT.id.burned('$5.00', '= 3,3 porsi nasi padang')).toBe('$5.00 terbakar sesi ini = 3,3 porsi nasi padang')
  })

  test('thresholds fire once each, in order', async () => {
    expect(crossed(0, 0.5, [])).toEqual([])
    expect(crossed(0.5, 1, [])).toEqual([1])
    expect(crossed(0.5, 12, [])).toEqual([1, 5, 10])
    expect(crossed(0.5, 12, [1, 5])).toEqual([10])
    expect(crossed(12, 11, [])).toEqual([])
  })

  test('in rupiah, thresholds are round rupiah amounts, fired by that amount', async () => {
    const idr = thresholds('idr', 16_000)
    expect(idr.map(t => t.at)).toEqual([20_000, 50_000, 100_000, 500_000, 1_000_000])
    expect(idr[0]!.usd).toBe(1.25)
    expect(crossed(0, 1.24, [], idr)).toEqual([])
    expect(crossed(1.24, 1.25, [], idr)).toEqual([20_000])
    expect(crossed(0, 7, [], idr)).toEqual([20_000, 50_000, 100_000])
    expect(crossed(0, 7, [20_000], thresholds('idr', 17_000))).toEqual([50_000, 100_000])
    expect(money(idr[0]!.usd, 'idr', 16_000)).toBe('Rp 20.000')
    expect(money(1_000_000 / 16_300, 'idr', 16_300)).toBe('Rp 1.000.000')
  })

  test('heat is 0 at nothing and full at $99', async () => {
    expect(heat(0)).toBe(0)
    expect(heat(99)).toBe(1)
  })

  test('tween eases toward the target and lands exactly', async () => {
    let x = 0
    for (let i = 0; i < 400 && x !== 3; i++) x = tween(x, 3)
    expect(x).toBe(3)
  })

  test('lifetime counts only new spend', async () => {
    expect(lifetimeDelta(null, 's1', 2)).toBe(2)
    expect(lifetimeDelta({ sessionId: 's1', usd: 2 }, 's1', 2.5)).toBe(0.5)
    expect(lifetimeDelta({ sessionId: 's1', usd: 2 }, 's2', 1)).toBe(1)
    expect(lifetimeDelta({ sessionId: 's1', usd: 5 }, 's1', 1)).toBe(1)
  })

  test('fire cells are columns * rows * 3 words of base64', async () => {
    const cells = fireCells(20, 0.5, 0.3, 1.2)
    expect(cells.length).toBe(Math.ceil((20 * FIRE_ROWS * 12) / 3) * 4)
  })

  test('the bar grows with spend', async () => {
    expect(barText(10, heat(0))).toBe('█░░░░░░░░░')
    expect(barText(10, heat(99))).toBe('██████████')
    expect(heat(30)).toBeGreaterThan(heat(5))
  })

  test('in rupiah the fuse heats on the same curve, full at Rp 1.000.000', async () => {
    expect(heat(0, 'idr', 16_000)).toBe(0)
    expect(heat(62.5, 'idr', 16_000)).toBe(1)
    expect(heat(1_000, 'idr', 16_000)).toBe(1)
    expect(Math.abs(heat(10_000 / 16_000, 'idr', 16_000) - Math.log10(2) / Math.log10(101))).toBeLessThan(1e-12)
    expect(heat(1, 'idr', 16_300)).toBeLessThan(0.25)
    expect(heat(5, 'usd')).toBe(heat(5))
  })

  test('subscription windows read out of rateLimits', async () => {
    const w = windows([
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-02T20:00:00Z' },
      { kind: 'seven_day', percentUsed: 41 },
    ])
    expect(w.session).toBe(23.5)
    expect(w.week).toBe(41)
    expect(windows([]).session).toBe(-1)
    expect(pct(-1)).toBe('--')
    expect(pct(23.5)).toBe('24%')
    const now = Date.parse('2026-10-02T17:46:00Z')
    expect(resetsIn('2026-10-02T20:00:00Z', now)).toBe('in 2h 14m')
    expect(resetsIn('2026-10-05T21:46:00Z', now)).toBe('in 3d 4h')
    expect(resetsIn('', now)).toBe('')
    expect(resetsIn('2026-10-02T20:00:00Z', now, 'id')).toBe('2j 14m lagi')
    expect(resetsIn('2026-10-05T21:46:00Z', now, 'id')).toBe('3hr 4j lagi')
    expect(resetsIn('2026-10-02T17:00:00Z', now, 'id')).toBe('sekarang')
  })

  test('model usage tallies per model, busiest first', async () => {
    const turn = (model: string, out: number) => ({
      model,
      input_tokens: 100,
      output_tokens: out,
      cache_read_input_tokens: 50_000,
      cache_creation_input_tokens: 900,
    })
    let m = tallyTurn({}, turn('claude-opus-5-5', 2000))
    m = tallyTurn(m, turn('claude-opus-5-5', 3000))
    m = tallyTurn(m, turn('claude-haiku-4-5-20251001', 500))
    expect(m['claude-opus-5-5']).toEqual({ input: 102_000, output: 5000, turns: 2 })
    expect(modelName('claude-opus-5-5')).toBe('opus 5.5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
    expect(modelName('gpt-x')).toBe('gpt-x')
    expect(modelsLine(m)).toBe('opus 5.5 102k in 5k out · haiku 4.5 51k in 500 out')
    expect(tokenCount(1_200_000)).toBe('1.2M')
  })
})