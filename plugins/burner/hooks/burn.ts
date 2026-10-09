/** Pure helpers for the burner: money formatting, comparisons, thresholds and the fuse frame. */

export const THRESHOLDS = [1, 5, 10, 25, 50] as const

/** The alerts when money shows in rupiah: round amounts, in rupiah. */
export const THRESHOLDS_IDR = [20_000, 50_000, 100_000, 500_000, 1_000_000] as const

export type Lang = 'en' | 'id'

/** What money shows in; every sum and stored total stays in dollars. */
export type Currency = 'usd' | 'idr'

type Thing = { one: string; many: string; usd: number }

export const THINGS: readonly Thing[] = [
  { one: 'burrito', many: 'burritos', usd: 11 },
  { one: 'McDouble', many: 'McDoubles', usd: 3.19 },
]

/** Rupiah per dollar when no `idrPerUsd` is set and no live rate is in. */
export const IDR_PER_USD = 16_300

/** Indonesian has no plural, so the measure word carries the count. Prices in rupiah. */
const FOODS_ID = [
  { one: 'porsi nasi padang', many: 'porsi nasi padang', idr: 25_000 },
  { one: 'mangkuk bakso', many: 'mangkuk bakso', idr: 20_000 },
  { one: 'gelas es teh manis', many: 'gelas es teh manis', idr: 5_000 },
] as const

/** The Indonesian foods priced in dollars at `idrPerUsd`. */
export const thingsId = (idrPerUsd: number): readonly Thing[] =>
  FOODS_ID.map(f => ({ one: f.one, many: f.many, usd: f.idr / idrPerUsd }))

export const THINGS_ID = thingsId(IDR_PER_USD)

/** exchangerate-api.com's free-plan endpoint for every rate against the dollar. */
export const fxUrl = (apiKey: string) => `https://v6.exchangerate-api.com/v6/${encodeURIComponent(apiKey)}/latest/USD`

/** Rupiah per dollar out of an exchangerate-api.com reply; null for an error or anything malformed. */
export const readRate = (text: string) => {
  try {
    const body = JSON.parse(text) as { result?: unknown; conversion_rates?: { IDR?: unknown } }
    const idr = body.result === 'success' ? body.conversion_rates?.IDR : undefined
    return typeof idr === 'number' && Number.isFinite(idr) && idr > 0 ? idr : null
  } catch {
    return null
  }
}

/** The `error-type` of an exchangerate-api.com error reply (`invalid-key`, `quota-reached`, ...), or ''. */
export const rateError = (text: string) => {
  try {
    const type = (JSON.parse(text) as Record<string, unknown>)['error-type']
    return typeof type === 'string' ? type : ''
  } catch {
    return ''
  }
}

/**
 * `text` with the key kept out: the key's segment of an exchangerate-api.com
 * URL (`/v6/<key>/`) whatever the key, and any other copy of a key of 8 or
 * more characters, raw or URL-encoded. A shorter key is only matched inside
 * the URL, so it does not star out every word that happens to contain it.
 */
export const redact = (text: string, secret: string) => {
  const masked = text.replace(/\/v6\/[^/\s]+\//g, '/v6/***/')
  return secret.length >= 8 ? [secret, encodeURIComponent(secret)].reduce((t, s) => t.split(s).join('***'), masked) : masked
}

/** How old a cached live rate may be and still stand in when a fetch fails. */
export const FX_STALE_MS = 30 * 24 * 60 * 60 * 1000

/** Whether a rate fetched at `fetchedAt` is recent enough to fall back on at `now`. */
export const isFresh = (fetchedAt: unknown, now: number) =>
  typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) && now - fetchedAt <= FX_STALE_MS

/** How many sessions keep their `last:` and `fired:` keys in the store. */
export const SESSIONS_KEPT = 100

/**
 * The session ids to keep, most recent last, with `id` added, and the ones
 * that fell off the end (whose keys are deleted).
 */
export const keepRecent = (ids: readonly string[], id: string, max: number = SESSIONS_KEPT) => {
  const kept = [...ids.filter(x => x !== id), id]
  const dropped = kept.length > max ? kept.slice(0, kept.length - max) : []
  return { kept: kept.slice(kept.length - Math.min(max, kept.length)), dropped }
}

/** `69.250` from 69250.4: whole rupiah, dots between thousands. */
const thousands = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')

/**
 * A dollar amount for display. Dollars: two decimals (12.34), or four under a
 * cent so the first fractions still move. Rupiah: converted at `idrPerUsd`,
 * whole rupiah with dots (Rp 69.250), or two decimals with a comma under
 * Rp 10 (Rp 6,85).
 */
export const money = (usd: number, currency: Currency = 'usd', idrPerUsd: number = IDR_PER_USD) => {
  if (currency === 'idr') {
    const idr = usd * idrPerUsd
    return 'Rp ' + (idr > 0 && idr < 10 ? idr.toFixed(2).replace('.', ',') : thousands(idr))
  }
  return '$' + (usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2))
}

/** `= 1.4 burritos` for the thing at `index`, wrapping; Indonesian writes `= 1,4 ...`. */
export const compare = (usd: number, index: number, things: readonly Thing[] = THINGS, lang: Lang = 'en') => {
  const thing = things[((index % things.length) + things.length) % things.length]!
  const count = usd / thing.usd
  const shown = count >= 10 ? count.toFixed(0) : count >= 1 ? count.toFixed(1) : count.toFixed(2)
  const name = shown === '1.0' || shown === '1' ? thing.one : thing.many
  return `= ${lang === 'id' ? shown.replace('.', ',') : shown} ${name}`
}

/** Every line the band, the pane, the toasts and `/burn` print, per language. */
export const TEXT = {
  en: {
    burn: 'BURN',
    demo: 'DEMO',
    sessionBurn: 'SESSION BURN',
    demoBurn: 'DEMO BURN',
    fiveHourShort: '5h',
    weekShort: 'wk',
    noModelTurns: 'no model turns yet',
    lifetime: 'lifetime',
    hide: 'hide',
    limits: 'Limits',
    fiveHour: '5 hour  ',
    weekly: 'weekly  ',
    perTurn: 'Per turn',
    noTurns: 'No finished turns yet.',
    thatIs: 'That is',
    command: 'Burner: /burn opens the panel; [panel|show|hide|demo|lifetime]',
    demoStarted: (from: string, to: string) => `Burn demo: ${from} to ${to} in 20 seconds.`,
    hidden: 'Burner hidden. /burn show brings it back.',
    burned: (usd: string, thing: string) => `${usd} burned this session ${thing}`,
    lifetimeLine: (usd: string, thing: string) => `Lifetime burn: ${usd} ${thing}.`,
    summary: (usd: string, thing: string, session: string, week: string, lifetime: string) =>
      `This session: ${usd} ${thing}. 5h ${session}, week ${week}. Lifetime: ${lifetime}.`,
    models: 'Models',
  },
  id: {
    burn: 'BURN',
    demo: 'DEMO',
    sessionBurn: 'BURN SESSION',
    demoBurn: 'BURN DEMO',
    fiveHourShort: '5j',
    weekShort: '7h',
    noModelTurns: 'belum ada model terpilih',
    lifetime: 'total',
    hide: 'sembunyikan',
    limits: 'Batas',
    fiveHour: '5 jam    ',
    weekly: 'mingguan ',
    perTurn: 'Per giliran',
    noTurns: 'Belum ada giliran selesai.',
    thatIs: 'Setara dengan',
    command: 'Burner: /burn membuka panel; [panel|show|hide|demo|lifetime]',
    demoStarted: (from: string, to: string) => `Demo burner: ${from} sampai ${to} dalam 20 detik.`,
    hidden: 'Burner disembunyikan. /burn show untuk menampilkannya lagi.',
    burned: (usd: string, thing: string) => `${usd} terbakar sesi ini ${thing}`,
    lifetimeLine: (usd: string, thing: string) => `Total terbakar: ${usd} ${thing}.`,
    summary: (usd: string, thing: string, session: string, week: string, lifetime: string) =>
      `Sesi ini: ${usd} ${thing}. 5 jam ${session}, minggu ${week}. Total: ${lifetime}.`,
    models: 'Model',
  },
} as const

/**
 * The plugin's options, defaults filled in: Indonesian unless `language` is
 * `en`, `comparisons: auto` and `currency: auto` follow the language, and
 * rupiah convert at `idrPerUsd` until a live rate replaces it (`withRate`).
 */
export const settings = (options?: Readonly<Record<string, unknown>>) => {
  const lang: Lang = options?.language === 'en' ? 'en' : 'id'
  const set: 'us' | 'id' =
    options?.comparisons === 'us' || options?.comparisons === 'id' ? options.comparisons : lang === 'id' ? 'id' : 'us'
  const currency: Currency =
    options?.currency === 'usd' || options?.currency === 'idr' ? options.currency : lang === 'id' ? 'idr' : 'usd'
  const manual = options?.idrPerUsd
  const idrPerUsd = typeof manual === 'number' && Number.isFinite(manual) && manual > 0 ? manual : IDR_PER_USD
  const apiKey = typeof options?.exchangeRateApiKey === 'string' ? options.exchangeRateApiKey.trim() : ''
  return withRate({ lang, text: TEXT[lang], set, currency, apiKey, idrPerUsd, things: THINGS }, idrPerUsd)
}

export type Settings = ReturnType<typeof settings>

/** Whether anything shown needs the rupiah rate: the Indonesian foods or rupiah money. */
export const needsRate = (s: Pick<Settings, 'set' | 'currency'>) => s.set === 'id' || s.currency === 'idr'

/** The same settings with the Indonesian foods priced at `idrPerUsd`. */
export const withRate = <S extends { set: 'us' | 'id' }>(s: S, idrPerUsd: number) => ({
  ...s,
  idrPerUsd,
  things: s.set === 'id' ? thingsId(idrPerUsd) : THINGS,
})

/** `842`, `84k`, `1.2M`. */
export const tokenCount = (n: number) =>
  n < 1000 ? `${Math.round(n)}` : n < 1e6 ? `${Math.round(n / 1000)}k` : `${(n / 1e6).toFixed(1)}M`

type Tally = { input: number; output: number; turns: number }
type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** Adds one turn's usage to the per-model tally. */
export const tallyTurn = (models: Readonly<Record<string, Tally>>, u: Usage) => {
  const was = models[u.model] ?? { input: 0, output: 0, turns: 0 }
  const input = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return { ...models, [u.model]: { input: was.input + input, output: was.output + u.output_tokens, turns: was.turns + 1 } }
}

/** `claude-opus-5-5` -> `opus 5.5`, `claude-haiku-4-5-20251001` -> `haiku 4.5`. */
export const modelName = (id: string) => {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/.exec(id)
  return m ? `${m[1]} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}

/** `opus 5.5 1.2M in 84k out · haiku 4.5 ...`, busiest first; '' when none. */
export const modelsLine = (models: Readonly<Record<string, Tally>>, max = 3) =>
  Object.entries(models)
    .sort((a, b) => b[1].output - a[1].output)
    .slice(0, max)
    .map(([id, t]) => `${modelName(id)} ${tokenCount(t.input)} in ${tokenCount(t.output)} out`)
    .join(' · ')

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** The 5-hour and 7-day subscription windows out of `rateLimits`; -1 where absent. */
export const windows = (limits: readonly Limit[]) => {
  const find = (kind: string) => limits.find(l => l.kind === kind)
  const s = find('five_hour')
  const w = find('seven_day')
  return {
    session: s ? s.percentUsed : -1,
    week: w ? w.percentUsed : -1,
    sessionResets: s?.resetsAt ?? '',
    weekResets: w?.resetsAt ?? '',
  }
}

/** `in 2h 14m`, `in 3d 4h`, `now`; Indonesian `2j 14m lagi`, `3hr 4j lagi`, `sekarang`; '' when unknown. */
export const resetsIn = (iso: string, now: number, lang: Lang = 'en') => {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return lang === 'id' ? 'sekarang' : 'now'
  const m = Math.floor(ms / 60_000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (lang === 'id') return d > 0 ? `${d}h ${h}j lagi` : h > 0 ? `${h}j ${m % 60}m lagi` : `${m}m lagi`
  return d > 0 ? `in ${d}d ${h}h` : h > 0 ? `in ${h}h ${m % 60}m` : `in ${m}m`
}

/** `42%`, or `--` with no reading. */
export const pct = (n: number) => (n < 0 ? '--' : `${Math.round(n)}%`)

/**
 * The alert thresholds for a display currency, each as the amount it is named
 * by (`at`: dollars, or rupiah) and that amount in dollars (`usd`), which is
 * what the spend is compared against.
 */
export const thresholds = (currency: Currency = 'usd', idrPerUsd: number = IDR_PER_USD) =>
  currency === 'idr'
    ? THRESHOLDS_IDR.map(at => ({ at, usd: at / idrPerUsd }))
    : THRESHOLDS.map(at => ({ at, usd: at }))

/**
 * Thresholds crossed going from `from` to `to` dollars that are not in
 * `fired`, by the amount they are named by: a rate that moves mid-session
 * does not fire Rp 20.000 twice.
 */
export const crossed = (from: number, to: number, fired: readonly number[], list = thresholds()) =>
  list.filter(t => from < t.usd && to >= t.usd && !fired.includes(t.at)).map(t => t.at)

/** 0..1 how hot the session is overall: log-scaled to $100, or to Rp 1.000.000 when money shows in rupiah. */
export const heat = (usd: number, currency: Currency = 'usd', idrPerUsd: number = IDR_PER_USD) => {
  // The same curve in either currency, the unit and the top scaled together:
  // $1 up to $99, or Rp 10.000 up to Rp 1.000.000.
  const { unit, top } = currency === 'idr' ? { unit: 10_000, top: 1_000_000 } : { unit: 1, top: 99 }
  const amount = currency === 'idr' ? usd * idrPerUsd : usd
  return Math.max(0, Math.min(1, Math.log10(1 + amount / unit) / Math.log10(1 + top / unit)))
}

/** Steps `shown` toward `target`: an odometer that eases but always lands. */
export const tween = (shown: number, target: number) => {
  const gap = target - shown
  if (Math.abs(gap) < 0.0005) return target
  const step = gap * 0.22
  return shown + (Math.abs(step) < 0.0005 ? Math.sign(gap) * 0.0005 : step)
}

/** How much to add to the lifetime total for a new reading in a session. */
export const lifetimeDelta = (
  last: { sessionId: string; usd: number } | null,
  sessionId: string,
  usd: number,
) => {
  const before = last && last.sessionId === sessionId ? last.usd : 0
  return usd >= before ? usd - before : usd
}

// --- the fuse, as Raster cells -------------------------------------------

const DEFAULT = 0x01000000
const GOLD = 0xc2a87e
const ORANGE = 0xe8833a
const RED = 0xe5484d
const WHITE = 0xfff4e0

const mix = (a: number, b: number, t: number) => {
  const ch = (shift: number) => Math.round(((a >> shift) & 0xff) * (1 - t) + ((b >> shift) & 0xff) * t)
  return (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/** The flame color for a heat 0..1: gold, then orange, then red. */
export const flame = (h: number) => (h < 0.5 ? mix(GOLD, ORANGE, h * 2) : mix(ORANGE, RED, (h - 0.5) * 2))

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export const toBase64 = (bytes: Uint8Array) => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

const YELLOW = 0xffd166
const EMPTY = 0x2a2724

// ' ▁▂▃▄▅▆▇█' by eighths.
const EIGHTHS = [0x20, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588]

export const FIRE_ROWS = 3

/** Cheap smooth noise: two beating sines, 0..1. */
const wobble = (x: number, t: number) =>
  0.5 + 0.25 * Math.sin(t * 9.1 + x * 1.7) + 0.25 * Math.sin(t * 5.3 - x * 2.9 + Math.sin(t * 2 + x))

/** The flame's color at a height 0..1 inside it: white-hot base, yellow, orange, red tips. */
const flameAt = (y: number, h: number) => {
  const tip = mix(ORANGE, RED, Math.min(1, 0.3 + h))
  return y < 0.25 ? mix(WHITE, YELLOW, y * 4) : y < 0.6 ? mix(YELLOW, ORANGE, (y - 0.25) / 0.35) : mix(ORANGE, tip, (y - 0.6) / 0.4)
}

/**
 * The fire bar, `columns` wide and FIRE_ROWS tall: a bar along the bottom row
 * filled to `fraction`, flames dancing on the filled part (tallest at the
 * leading edge, taller as `h` rises), sparks drifting off the top.
 */
export const fireCells = (columns: number, fraction: number, h: number, t: number, rows: number = FIRE_ROWS) => {
  const words = new Uint32Array(columns * rows * 3)
  const filled = Math.max(1, Math.round(fraction * columns))
  const flameRows = rows - 1
  const put = (x: number, y: number, glyph: number, fg: number) => {
    const i = (y * columns + x) * 3
    words[i] = glyph
    words[i + 1] = fg
    words[i + 2] = DEFAULT
  }
  for (let x = 0; x < columns; x++) {
    for (let y = 0; y < flameRows; y++) put(x, y, 0x20, DEFAULT)
    // The bar.
    if (x < filled) {
      const along = filled <= 1 ? 1 : x / (filled - 1)
      const edge = x === filled - 1
      const fg = edge && Math.floor(t * 14) % 2 === 0 ? WHITE : mix(GOLD, flame(Math.max(h, along * h)), along)
      put(x, rows - 1, 0x2588, fg)
    } else {
      put(x, rows - 1, 0x2591, EMPTY) // ░
      continue
    }
    // The flames over the filled part, in eighths.
    const lead = 1 - Math.min(1, (filled - 1 - x) / Math.max(4, filled * 0.6))
    const height = flameRows * 8 * Math.min(1, (0.35 + 0.4 * h + 0.45 * lead) * (0.35 + 0.9 * wobble(x, t)))
    for (let y = 0; y < flameRows; y++) {
      const fromBottom = flameRows - 1 - y
      const eighths = Math.max(0, Math.min(8, Math.round(height - fromBottom * 8)))
      if (eighths > 0) put(x, y, EIGHTHS[eighths]!, flameAt(fromBottom / flameRows + eighths / (8 * flameRows), h))
    }
    // A spark off the top, now and then.
    if (height < 9 && wobble(x * 3.1, t * 1.7) > 0.86) put(x, 0, Math.floor(t * 10 + x) % 2 ? 0xb7 : 0x2a, mix(YELLOW, ORANGE, h))
  }
  return toBase64(new Uint8Array(words.buffer))
}

/** The same bar as text, for surfaces without a Raster. */
export const barText = (columns: number, fraction: number) => {
  const filled = Math.max(1, Math.round(fraction * columns))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, columns - filled))
}