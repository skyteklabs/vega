import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Burn, ModelTally } from '../types'
import { FIRE_ROWS, barText, compare, crossed, fireCells, thresholds, fxUrl, heat, isFresh, keepRecent, lifetimeDelta, modelsLine, money, needsRate, pct, rateError, readRate, redact, resetsIn, settings, tallyTurn, tween, windows, withRate } from './burn'

const burn = atom({ plugin: 'burner', key: 'burn' } as const, {
  shown: 0,
  target: 0,
  isDemo: false,
  lifetime: 0,
  session: -1,
  week: -1,
  sessionResets: '',
  weekResets: '',
} as Burn)
const isHidden = atom({ plugin: 'burner', key: 'isHidden' } as const, false)
const models = atom({ plugin: 'burner', key: 'models' } as const, {} as Record<string, ModelTally>)
const turns = atom({ plugin: 'burner', key: 'turns' } as const, [] as number[])
const turnStart = atom({ plugin: 'burner', key: 'turnStart' } as const, 0)

const GOLD = '#c2a87e'
const PAPER = '#E8E2D6'
const RED = '#e5484d'
const ORANGE = '#e8833a'

const DEMO_MS = 20_000
const DEMO_TOP = 30
const DEMO_HOLD_MS = 6_000

let tweenTimer: { cancel: () => void } | null = null
let sparkTimer: { cancel: () => void } | null = null
let sparkSize = 0
// Set when a blit rejected (not refused): the next cost tick restarts the band's fire.
let isSparkFailed = false
let bandId: string | null = null
let demoStartedAt = 0
let demoFired: number[] = []
let demoRamp: { cancel: () => void } | null = null
let demoHold: { cancel: () => void } | null = null
// The session's own timers, cancelled when another session starts in this process.
let sessionTimers: Array<{ cancel: () => void }> = []
let paneTimer: { cancel: () => void } | null = null
let paneSize = ''
// The options, read once at register.
let cfg = settings()
// Cost readings run one at a time; the first after a load fetches the rate.
let costChain: Promise<void> = Promise.resolve()
let isQueued = false
let isRateLoaded = false
let hasLoggedCostError = false
// The session whose id was last moved to the front of the store's session list.
let rememberedId = ''

const PANE = 'burn'
const PANE_FIRE_ROWS = 8
const TURNS_KEPT = 12
const FX_TIMEOUT_MS = 3_000

type FxCache = { sessionId: string; idrPerUsd: number; fetchedAt: number }

/** Animates the pane's tall fire while the pane is mounted; stops once a blit is refused. */
const startPaneFire = ($: EngineInterface, columns: number) => {
  const size = `${columns}x${PANE_FIRE_ROWS}`
  if (paneTimer && paneSize === size) return
  paneTimer?.cancel()
  paneSize = size
  const stopPane = () => {
    timer.cancel()
    if (paneTimer === timer) paneTimer = null
  }
  const timer = $.clock.every(70, () => {
    void Promise.all([read($, burn), $.clock.now()]).then(([b, now]) =>
      $.ui
        .blit({
          requestId: PANE,
          key: 'bigfire',
          cells: fireCells(columns, fill(b), fill(b), now / 1000, PANE_FIRE_ROWS),
        })
        .then(r => r.deny && stopPane())
        // A rejected blit is a refusal too: stop rather than fail every frame.
        .catch(stopPane),
    )
  })
  paneTimer = timer
}

/** `compare` in the configured language, against the configured things. */
const thatIs = (usd: number, index: number) => compare(usd, index, cfg.things, cfg.lang)

/** `money` in the configured currency; the dollars underneath stay dollars. */
const cash = (usd: number) => money(usd, cfg.currency, cfg.idrPerUsd)

/**
 * Prices the Indonesian foods at the live rupiah rate. With an API key the
 * rate is fetched once per new session and cached in the store, and it
 * overrides `idrPerUsd`; a failed fetch falls back to the last cached rate,
 * then to `idrPerUsd`. With no key, `idrPerUsd` stands and nothing is fetched.
 */
const loadRate = async ($: EngineInterface) => {
  if (!needsRate(cfg)) return
  const apiKey = cfg.apiKey || ((await $.env.get('EXCHANGERATE_API_KEY')) ?? '').trim()
  if (!apiKey) return
  const sessionId = await $.session.id()
  const cached = ((await $.store.get('fx')) ?? null) as FxCache | null
  if (cached && cached.sessionId === sessionId) {
    cfg = withRate(cfg, cached.idrPerUsd)
    $.ui.invalidate('ui.render')
    return
  }
  let rate: number | null = null
  try {
    const response = await Promise.race([$.http.fetch(fxUrl(apiKey)), $.clock.sleep(FX_TIMEOUT_MS)])
    if (!response) $.ui.log(`[burner] exchange rate passed ${FX_TIMEOUT_MS}ms`)
    else {
      rate = readRate(response.text)
      if (rate === null) $.ui.log(redact(`[burner] exchange rate failed: ${rateError(response.text) || response.status}`, apiKey))
    }
  } catch (error) {
    // A network error can quote the URL, and the URL carries the key.
    $.ui.log(redact(`[burner] exchange rate failed: ${String(error)}`, apiKey))
  }
  if (rate !== null) {
    await $.store.set('fx', { sessionId, idrPerUsd: rate, fetchedAt: await $.clock.now() } satisfies FxCache)
    cfg = withRate(cfg, rate)
  } else if (cached && isFresh(cached.fetchedAt, await $.clock.now())) cfg = withRate(cfg, cached.idrPerUsd)
  $.ui.invalidate('ui.render')
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: 'Burner', focus: true })

type Reading = { sessionId: string; usd: number }

/**
 * Queues a cost reading behind the one in flight: `readCost` reads the
 * lifetime total and writes it back, so two at once would count a delta
 * twice. At most one reading waits: a call while one is already queued joins
 * it, so a slow reading never piles up a backlog from the 1s timer. The
 * first reading after a load waits for the rupiah rate, so a hot reload
 * (which keeps the session but resets the options) picks it up again from
 * the cache, and the first alerts already compare at it.
 */
const syncCost = ($: EngineInterface) => {
  if (isQueued) return costChain
  isQueued = true
  costChain = costChain
    .then(async () => {
      isQueued = false
      if (!isRateLoaded) {
        isRateLoaded = true
        await loadRate($).catch(() => undefined)
      }
      await readCost($)
    })
    .catch(error => {
      if (hasLoggedCostError) return
      hasLoggedCostError = true
      $.ui.log(`[burner] cost reading failed: ${String(error)}`)
    })
  return costChain
}

/**
 * Moves this session to the front of the store's session list, deleting the
 * `last:` and `fired:` keys of the sessions that fall off its end.
 */
const rememberSession = async ($: EngineInterface, sessionId: string) => {
  if (rememberedId === sessionId) return
  rememberedId = sessionId
  const ids = await $.store.get('sessions')
  const { kept, dropped } = keepRecent(Array.isArray(ids) ? (ids as string[]) : [], sessionId)
  await $.store.set('sessions', kept)
  for (const old of dropped) {
    await $.store.delete(`last:${old}`)
    await $.store.delete(`fired:${old}`)
  }
}

/** Folds a real cost reading into the lifetime total and the target. */
const readCost = async ($: EngineInterface) => {
  const usage = await $.session.usage()
  const usd = usage.cost?.usd ?? 0
  const sub = windows(usage.rateLimits)
  const sessionId = await $.session.id()
  await rememberSession($, sessionId)
  const lastKey = `last:${sessionId}`
  const last = ((await $.store.get(lastKey)) ?? null) as Reading | null
  const delta = lifetimeDelta(last, sessionId, usd)
  const stored = Number((await $.store.get('lifetime')) ?? 0)
  const lifetime = stored + delta
  if (delta !== 0 || !last || last.sessionId !== sessionId) {
    await $.store.set('lifetime', lifetime)
    await $.store.set(lastKey, { sessionId, usd })
  }
  const now = await read($, burn)
  if (
    now.session !== sub.session ||
    now.week !== sub.week ||
    now.sessionResets !== sub.sessionResets ||
    now.weekResets !== sub.weekResets
  ) {
    await update($, burn, b => ({ ...b, ...sub }))
  }
  if (now.isDemo) {
    if (now.lifetime !== lifetime) await update($, burn, b => ({ ...b, lifetime }))
    return
  }
  if (now.target !== usd || now.lifetime !== lifetime) {
    await alarm($, now.target, usd, false)
    await update($, burn, b => ({ ...b, target: usd, lifetime }))
  }
  startTween($)
}

/**
 * Toasts each threshold the spend just crossed, once per session (or per
 * demo). What fired is kept in the store by session id, not in session state,
 * so a resumed session (whose odometer starts again from 0) does not replay
 * the thresholds below its cost.
 */
const alarm = async ($: EngineInterface, from: number, to: number, isDemo: boolean) => {
  const firedKey = isDemo ? '' : `fired:${await $.session.id()}`
  const already = isDemo ? demoFired : (((await $.store.get(firedKey)) ?? []) as number[])
  const list = thresholds(cfg.currency, cfg.idrPerUsd)
  const hits = crossed(from, to, already, list)
  if (hits.length === 0) return
  const top = hits[hits.length - 1]!
  const index = list.findIndex(t => t.at === top)
  $.ui.toast(cfg.text.burned(cash(list[index]!.usd), thatIs(list[index]!.usd, index)), { timeoutMs: 6000 })
  if (isDemo) demoFired = [...demoFired, ...hits]
  else await $.store.set(firedKey, [...already, ...hits])
}

/** Eases the odometer toward its target, 20 frames a second, and stops once it lands. */
const startTween = ($: EngineInterface) => {
  if (tweenTimer) return
  const timer = $.clock.every(50, () => {
    void read($, burn).then(async b => {
      if (b.shown === b.target) {
        timer.cancel()
        if (tweenTimer === timer) tweenTimer = null
        return
      }
      await update($, burn, x => ({ ...x, shown: tween(x.shown, x.target) }))
    })
  })
  tweenTimer = timer
}

/** The bar's fill: the 5-hour window on a subscription, else the spend's heat. */
const fill = (b: Burn) => (b.isDemo || b.session < 0 ? heat(b.shown, cfg.currency, cfg.idrPerUsd) : Math.max(0.02, Math.min(1, b.session / 100)))

/** Animates the fire by blitting the bar while the band is mounted. */
const startSpark = ($: EngineInterface, columns: number) => {
  if (sparkTimer && sparkSize === columns) return
  sparkTimer?.cancel()
  sparkSize = columns
  const stopSpark = () => {
    timer.cancel()
    if (sparkTimer === timer) sparkTimer = null
  }
  isSparkFailed = false
  const timer = $.clock.every(80, () => {
    if (!bandId) return
    void Promise.all([read($, burn), $.clock.now()]).then(([b, now]) =>
      $.ui
        .blit({
          requestId: bandId!,
          key: 'fire',
          cells: fireCells(columns, fill(b), fill(b), now / 1000),
        })
        .then(r => r.deny && stopSpark())
        // Refused means the band is gone; rejected may pass, so the next tick tries again.
        .catch(() => {
          stopSpark()
          isSparkFailed = true
        }),
    )
  })
  sparkTimer = timer
}

const runDemo = async ($: EngineInterface) => {
  // A demo started over a running one replaces it, ramp and hold alike.
  demoRamp?.cancel()
  demoHold?.cancel()
  demoHold = null
  demoStartedAt = await $.clock.now()
  demoFired = []
  await update($, isHidden, () => false)
  await update($, burn, b => ({ ...b, shown: 0, target: 0, isDemo: true }))
  const ramp = $.clock.every(100, () => {
    // Replaced while this demo was still starting: stop for good, not just skip.
    if (demoRamp !== ramp) {
      ramp.cancel()
      return
    }
    void $.clock.now().then(async now => {
      const t = Math.min(1, (now - demoStartedAt) / DEMO_MS)
      // Slow start, steep finish: how a long agent session actually feels.
      const target = DEMO_TOP * t * t * (0.35 + 0.65 * t)
      const before = (await read($, burn)).target
      await alarm($, before, target, true)
      await update($, burn, b => ({ ...b, target }))
      startTween($)
      if (t >= 1 && demoRamp === ramp) {
        ramp.cancel()
        demoRamp = null
        demoHold = $.clock.after(DEMO_HOLD_MS, () => {
          demoHold = null
          void update($, burn, b => ({ ...b, isDemo: false, shown: 0, target: 0 })).then(() => syncCost($))
        })
      }
    })
  })
  demoRamp = ramp
}

export const register: Register = (on, options) => {
  cfg = settings(options)
  isRateLoaded = false

  on('session.start', async ($, e, next) => {
    // A new session in this process (after /clear, say) fetches its own rate
    // and replaces the last one's timers rather than running beside them.
    isRateLoaded = false
    for (const timer of sessionTimers) timer.cancel()
    sessionTimers = []
    // Registering again replaces the command; any other refusal must not stop the band.
    await $.command
      .register({ name: 'burn', description: cfg.text.command })
      .catch(error => $.ui.log(`[burner] /burn not registered: ${String(error)}`))
    void syncCost($)
    sessionTimers = [
      $.clock.every(1000, () => {
        void syncCost($)
        if (isSparkFailed && bandId && !sparkTimer) startSpark($, sparkSize)
      }),
      // The comparison rotates every six seconds even while the spend sits still.
      $.clock.every(6000, () => $.ui.invalidate('ui.render')),
    ]

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const usd = (await $.session.usage()).cost?.usd ?? 0
    await update($, turnStart, () => usd)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const usage = done.usage
    if (usage) await update($, models, m => tallyTurn(m, usage))
    // Not awaited: a reading that never resolves must not hold every later turn.
    void syncCost($)
    const usd = (await $.session.usage()).cost?.usd ?? 0
    const spent = Math.max(0, usd - (await read($, turnStart)))
    await update($, turns, list => [...list, spent].slice(-TURNS_KEPT))
    await update($, turnStart, () => usd)
    return done
  })

  on('command.run', { command: 'burn' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'demo') {
      void openPane($)
      await runDemo($)
      return { text: cfg.text.demoStarted(cash(0), cash(DEMO_TOP)) }
    }
    if (arg === 'hide') {
      await update($, isHidden, () => true)
      return { text: cfg.text.hidden }
    }
    const b = await read($, burn)
    if (arg === 'lifetime') {
      const which = Math.floor((await $.clock.now()) / 6000) % cfg.things.length
      return { text: cfg.text.lifetimeLine(cash(b.lifetime), thatIs(b.lifetime, which)) }
    }
    await update($, isHidden, () => false)
    if (arg === '' || arg === 'panel') void openPane($)
    const used = modelsLine(await read($, models), 6)
    const summary = cfg.text.summary(cash(b.target), thatIs(b.target, 0), pct(b.session), pct(b.week), cash(b.lifetime))
    return { text: `${summary}${used ? `\n${cfg.text.models}: ${used}` : ''}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const b = await read($, burn)
    if (b.target <= 0 && b.session < 0 && !b.isDemo) return next(e)

    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Raster = 'Raster' in elements ? elements.Raster : null
    const hasFire = Raster !== null && e.surface === 'terminal'
    const now = await $.clock.now()
    const cols = Math.max(40, e.props.bodyColumns || 80)
    const level = fill(b)
    const color = level > 0.75 ? RED : level > 0.45 ? ORANGE : GOLD
    const isRolling = b.shown !== b.target
    const bar = Math.max(12, Math.min(64, cols - 46))
    const used = modelsLine(await read($, models), cols >= 140 ? 2 : 1)
    const which = Math.floor(now / 6000) % cfg.things.length
    const sessionLine = `${cfg.text.fiveHourShort} ${pct(b.session)} ${resetsIn(b.sessionResets, now, cfg.lang)}`.trim()
    const weekLine = `${cfg.text.weekShort} ${pct(b.week)} ${resetsIn(b.weekResets, now, cfg.lang)}`.trim()

    if (hasFire) {
      bandId = e.requestId
      startSpark($, bar)
    }

    return (
      <Box gap={2} alignItems="flex-end">
        <Box flexDirection="column">
          <Text color={color} bold>{b.isDemo ? cfg.text.demo : cfg.text.burn}</Text>
          <Text color={color} bold>{sessionLine}</Text>
          <Text dimColor>{weekLine}</Text>
        </Box>
        {hasFire ? (
          <Raster key="fire" columns={bar} rows={FIRE_ROWS} cells={fireCells(bar, level, level, now / 1000)} />
        ) : (
          <Text color={color}>{barText(bar, level)}</Text>
        )}
        <Box flexDirection="column">
          <Text>
            <Text color={isRolling ? color : PAPER} bold>{cash(b.shown)}</Text>
            <Text color={GOLD}>{` ${thatIs(b.shown, which)}`}</Text>
          </Text>
          <Text dimColor>{used || cfg.text.noModelTurns}</Text>
          <Box gap={2}>
            <Text dimColor>{`${cfg.text.lifetime} ${cash(b.lifetime)}`}</Text>
            <Button key="hide" label={cfg.text.hide} plain onPress={() => void update($, isHidden, () => true)} />
          </Box>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text } = elements
    const Raster = 'Raster' in elements ? elements.Raster : null
    const hasFire = Raster !== null && e.surface === 'terminal'
    const b = await read($, burn)
    const history = await read($, turns)
    const now = await $.clock.now()
    const cols = Math.max(40, e.props.bodyColumns || e.viewport?.columns || 80)
    const width = cols - 2
    const level = fill(b)
    const color = level > 0.75 ? RED : level > 0.45 ? ORANGE : GOLD
    const isRolling = b.shown !== b.target
    const meter = Math.max(10, Math.min(40, width - 24))
    const windowBar = (n: number) => (n < 0 ? '' : barText(meter, Math.max(0, Math.min(1, n / 100))))
    const top = Math.max(0.01, ...history)
    const turnBar = Math.max(8, Math.min(36, width - 22))

    if (hasFire) startPaneFire($, width)

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text color={color} bold>{b.isDemo ? cfg.text.demoBurn : cfg.text.sessionBurn}</Text>
          <Text dimColor>{`${cfg.text.lifetime} ${cash(b.lifetime)}`}</Text>
        </Box>
        <Text>
          <Text color={isRolling ? color : PAPER} bold>{cash(b.shown)}</Text>
          <Text color={GOLD}>{`  ${thatIs(b.shown, Math.floor(now / 6000) % cfg.things.length)}`}</Text>
        </Text>
        <Box marginY={1}>
          {hasFire ? (
            <Raster key="bigfire" columns={width} rows={PANE_FIRE_ROWS} cells={fireCells(width, level, level, now / 1000, PANE_FIRE_ROWS)} />
          ) : (
            <Text color={color}>{barText(width, level)}</Text>
          )}
        </Box>

        {(b.session >= 0 || b.week >= 0) && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold color={PAPER}>{cfg.text.limits}</Text>
            {b.session >= 0 && (
              <Text>
                <Text dimColor>{cfg.text.fiveHour}</Text>
                <Text color={b.session > 75 ? RED : GOLD}>{windowBar(b.session)}</Text>
                <Text>{` ${pct(b.session)} `}</Text>
                <Text dimColor>{resetsIn(b.sessionResets, now, cfg.lang)}</Text>
              </Text>
            )}
            {b.week >= 0 && (
              <Text>
                <Text dimColor>{cfg.text.weekly}</Text>
                <Text color={b.week > 75 ? RED : GOLD}>{windowBar(b.week)}</Text>
                <Text>{` ${pct(b.week)} `}</Text>
                <Text dimColor>{resetsIn(b.weekResets, now, cfg.lang)}</Text>
              </Text>
            )}
          </Box>
        )}

        <Box flexDirection="column" marginBottom={1}>
          <Text bold color={PAPER}>{cfg.text.perTurn}</Text>
          {history.length === 0 && <Text dimColor>{cfg.text.noTurns}</Text>}
          {history.map((usd, i) => (
            <Text key={`turn-${i}`}>
              <Text dimColor>{`#${String(i + 1).padStart(2, ' ')}  `}</Text>
              <Text color={usd === top && history.length > 1 ? ORANGE : GOLD}>{barText(turnBar, usd / top)}</Text>
              <Text>{` ${cash(usd)}`}</Text>
            </Text>
          ))}
        </Box>

        <Box flexDirection="column">
          <Text bold color={PAPER}>{cfg.text.thatIs}</Text>
          {cfg.things.map((_, i) => (
            <Text key={`thing-${i}`} color={GOLD}>{thatIs(b.shown, i)}</Text>
          ))}
        </Box>
      </Box>
    )
  })
}