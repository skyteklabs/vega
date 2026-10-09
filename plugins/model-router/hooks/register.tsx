/**
 * model-router — Claude Mod
 *
 * Picks the model each task runs on with TypeSafe's Jev, a System One
 * decision model: unstructured state in, a typed choice with a probability
 * distribution out.
 *
 * Jev is reached one of two ways, whichever key is configured: TypeSafe's
 * own API (`typesafeApiKey`), which reports a calibrated confidence per
 * answer, or the Vercel AI Gateway (`gatewayApiKey`), which does not. With
 * neither, the engine's own `$.model.classify` stands in, so the mod is
 * useful without any account.
 *
 * Three things it can set, each on its own switch:
 *   agent.spawn  — the model of each subagent (on by default)
 *   turn.step    — the reasoning effort of the main loop (on by default)
 *   turn.step    — the model of the main loop (on by default; switching
 *                  models mid-session invalidates the prompt cache, which can
 *                  cost more than the cheaper tier saves)
 *
 * Every one of them moves in both directions: a task the decision model reads
 * as mechanical is routed down, one it reads as hard is routed up. The two
 * mistakes do not cost the same, so they do not clear the same confidence bar
 * (see `minUpgradeConfidence` / `minDowngradeConfidence` in policy.ts).
 *
 * The Agent tool has no effort parameter, so a subagent's effort is not ours
 * to set; only its model is.
 *
 * The prompt is classified at `prompt.submit`, which runs before the turn
 * starts, and the decision is applied at the turn's first request.
 *
 * Every failure path is fail-open: a classification that errors or runs past
 * the latency budget leaves the request exactly as the engine built it.
 *
 * The API key comes from the plugin's options (userConfig "typesafeApiKey"
 * or "gatewayApiKey"); with no "typesafeApiKey" set, the TYPESAFE_API_KEY
 * environment variable is used. Never hardcode it in this file.
 *
 * Needs Claude Code >= 2.1.287. Typed
 * against Anthropic's declarations: https://github.com/anthropics/claude-code/tree/main/mods
 *
 * Privacy: with a key set, the prompt text is sent to whichever backend the
 * key belongs to.
 */
import type { Register } from 'claude-code'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  describeDecision,
  describeSetup,
  describeStatus,
  endpoint,
  pendingDecisions,
  readDecision,
  selectProvider,
  requestBody,
  requestHeaders,
  requestModelId,
  route,
  rubricScore,
  BUILTIN_EFFORT_LABELS,
  TIER_ORDER,
  bareCommand,
} from './policy.ts'
import type { Decision, Effort, PolicyConfig, Provider, Tier } from './policy.ts'

/**
 * What a built-in classification resolves to when it is still out at its
 * deadline: a sentinel, since `$.model.classify` itself may resolve undefined.
 */
const TIMED_OUT = Symbol('timed out')

/** `work`, or TIMED_OUT if `deadline` comes first. */
function within<T>(work: Promise<T>, deadline: Promise<void>): Promise<T | typeof TIMED_OUT> {
  return Promise.race([work, deadline.then(() => TIMED_OUT)])
}

export const register: Register = (on, options) => {
  const text = (key: string, fallback: string) =>
    typeof options[key] === 'string' && options[key] ? (options[key] as string) : fallback
  const number = (key: string, fallback: number) =>
    typeof options[key] === 'number' ? (options[key] as number) : fallback
  const flag = (key: string, fallback: boolean) =>
    typeof options[key] === 'boolean' ? (options[key] as boolean) : fallback

  // TypeSafe's own API is preferred when both keys are set: it is the only
  // one that reports a calibrated confidence, which the policy's threshold
  // reads. `provider` forces one, including "builtin" to use neither.
  const gatewayKey = text('gatewayApiKey', '')
  const forced = text('provider', 'auto')

  // The TypeSafe key falls back to the TYPESAFE_API_KEY environment variable,
  // which only a hook can read, so the backend is settled on the first hook
  // call rather than here.
  let active: Provider | null = null
  let apiKey = ''
  let modelId = ''
  let url = ''
  // A backend named in the options but missing its key degrades to the
  // built-in classifier, which is silent; say so once, when a hook first runs.
  let unusableReported = true
  let resolved = false
  const resolveBackend = (envTypesafeKey: string | undefined) => {
    if (resolved) return
    resolved = true
    const typesafeKey = text('typesafeApiKey', envTypesafeKey ?? '')
    active = selectProvider(forced, typesafeKey, gatewayKey)
    // Each backend keeps its own URL and model, so an override written for one
    // can never be sent to the other when `auto` picks differently than expected.
    apiKey = active === 'typesafe' ? typesafeKey : active === 'gateway' ? gatewayKey : ''
    modelId = !active
      ? ''
      : active === 'typesafe'
        ? text('typesafeModel', DEFAULT_MODEL.typesafe)
        : text('gatewayModel', DEFAULT_MODEL.gateway)
    url = !active
      ? ''
      : active === 'typesafe'
        ? endpoint('typesafe', text('typesafeBaseUrl', DEFAULT_BASE_URL.typesafe))
        : endpoint('gateway', text('gatewayBaseUrl', DEFAULT_BASE_URL.gateway))
    unusableReported = forced === 'auto' || forced === 'builtin' || active !== null
  }

  const timeoutMs = number('timeoutMs', 800)
  const routeSubagentModel = flag('routeSubagentModel', true)
  const routeMainEffort = flag('routeMainEffort', true)
  const routeMainModel = flag('routeMainModel', true)
  const routeMainLoop = routeMainEffort || routeMainModel
  const logDecisions = flag('logDecisions', true)

  const policy: PolicyConfig = {
    tiers: {
      fast: text('fastModel', 'haiku'),
      balanced: text('balancedModel', 'sonnet'),
      deep: text('deepModel', 'opus'),
    },
    minUpgradeConfidence: number('minUpgradeConfidence', 0.3),
    minDowngradeConfidence: number('minDowngradeConfidence', 0.6),
  }

  // The classification waiting for the turn that reads its prompt, and what
  // the current turn settled on. Both are single slots: main-loop turns run
  // one at a time, so nothing accumulates over a long session. `pending`
  // reports no decision when two prompts are waiting at once, rather than
  // routing a turn on a decision made for a different prompt.
  const pending = pendingDecisions()
  // Said once, the first time a hook runs. A router that loaded and one that
  // never loaded are otherwise told apart only by the absence of later lines,
  // and absence is not evidence: the policy leaves most turns alone anyway.
  let announced = false
  let appliedTurnId: string | undefined
  let applied: { model?: string; effort?: Effort } | null = null

  on('prompt.submit', async ($, e, next) => {
    if (!resolved) resolveBackend(await $.env.get('TYPESAFE_API_KEY'))
    // Before the routing guards: a module whose switches are all off has still
    // loaded, and that is exactly when its silence is most misleading.
    if (!announced) {
      announced = true
      if (logDecisions) {
        $.ui.log(
          `[model-router] ${describeSetup(
            active,
            url,
            {
              subagentModel: routeSubagentModel,
              mainEffort: routeMainEffort,
              mainModel: routeMainModel,
            },
            forced === 'builtin',
          )}`,
        )
      }
    }
    if (!routeMainLoop) return next(e)

    if (!unusableReported) {
      unusableReported = true
      $.ui.log(`[model-router] provider "${forced}" has no key set; using the built-in classifier`)
    }

    // A slash command alone gives the decision model only the command's name.
    // Its turn keeps the session's model and effort; the null put keeps a
    // previous prompt's decision from reaching it.
    if (bareCommand(e.text)) {
      if (logDecisions) $.ui.log('[model-router] a command with nothing after it; leaving the turn alone')
      pending.put(null)
      return next(e)
    }

    const startedAt = await $.clock.now()
    let decision: Decision | null = null
    if (active) {
      try {
        const response = await Promise.race([
          $.http.fetch(url, {
            method: 'POST',
            headers: requestHeaders(active, apiKey, modelId),
            body: requestBody(active, { prompt: e.text }, modelId),
          }),
          $.clock.sleep(timeoutMs),
        ])
        if (response && response.ok) decision = readDecision(response.text)
        else if (response) $.ui.log(`[model-router] ${active} responded ${response.status}`)
        else $.ui.log(`[model-router] classification passed ${timeoutMs}ms; leaving the turn alone`)
      } catch (error) {
        $.ui.log(`[model-router] classification failed: ${String(error)}`)
      }
    } else {
      // No backend: the engine's own small-model classifier answers the same
      // questions, without the confidence the policy's threshold reads. The
      // effort is asked separately, on the backend's rubric reworded to carry
      // its own question, so a failure there still leaves the tier.
      const classify = (labels: readonly string[]) =>
        $.model.classify(e.text, labels).catch((error: unknown) => {
          $.ui.log(`[model-router] built-in classifier failed: ${String(error)}`)
          return undefined
        })
      // The same latency budget as a backend, one deadline for both calls but
      // each raced on its own: an effort answer still out at the deadline
      // costs only the effort, never a tier that already came back.
      const deadline = $.clock.sleep(timeoutMs)
      const [label, effortLabel] = await Promise.all([
        within(classify(TIER_ORDER), deadline),
        routeMainEffort ? within(classify(BUILTIN_EFFORT_LABELS), deadline) : undefined,
      ])
      if (label === TIMED_OUT) {
        $.ui.log(`[model-router] classification passed ${timeoutMs}ms; leaving the turn alone`)
      } else if (label) {
        if (effortLabel === TIMED_OUT) {
          $.ui.log(`[model-router] effort classification passed ${timeoutMs}ms; routing the tier alone`)
        }
        decision = {
          tier: label as Tier,
          confidence: null,
          risky: null,
          effort: effortLabel === TIMED_OUT ? null : rubricScore(effortLabel),
          effortConfidence: null,
        }
      }
    }

    // What the decision model actually answered, whatever the policy then
    // does with it. This is the line that proves the classification ran.
    if (logDecisions) {
      const ms = (await $.clock.now()) - startedAt
      $.ui.log(`[model-router] jev: ${describeDecision(decision, ms)}`)
    }

    pending.put(decision)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!routeMainLoop || e.agentId) return yield* next(e)

    // Every request after the first reuses what the turn settled on, so
    // neither the model nor the effort changes under its own tool loop.
    if (e.index > 0 && e.turnId === appliedTurnId) {
      return yield* next(applied ? { ...e, ...applied } : e)
    }

    const decision = pending.take()
    const routing = route(decision, { model: e.model, effort: e.effort }, policy)
    const change: { model?: string; effort?: Effort } = {}
    // The main loop's `model` is sent to the API as written, so an alias
    // becomes its id here; a subagent's (agent.spawn) may stay an alias.
    if (routeMainModel && routing.model) change.model = requestModelId(routing.model)
    if (routeMainEffort && routing.effort) change.effort = routing.effort

    appliedTurnId = e.turnId
    applied = Object.keys(change).length > 0 ? change : null
    // A row in the transcript scrolls away; this line stays on screen.
    if (logDecisions) $.ui.status(describeStatus(decision, applied))

    if (!applied) {
      // A turn left alone is the common case, and it used to be silent, which
      // made a working mod look like one that never loaded. Say what happened.
      if (logDecisions) {
        const suppressed = routing.model && !routeMainModel ? ' (main-loop model routing off)' : ''
        $.ui.log(`[model-router] main loop: ${routing.reason}${suppressed}`)
      }
      return yield* next(e)
    }
    if (logDecisions) {
      const what = [change.model, change.effort && `effort ${change.effort}`]
        .filter(Boolean)
        .join(', ')
      $.ui.log(`[model-router] main loop → ${what}: ${routing.reason}`)
    }
    return yield* next({ ...e, ...change })
  })

  on('agent.spawn', async ($, e, next) => {
    if (!resolved) resolveBackend(await $.env.get('TYPESAFE_API_KEY'))
    // Before the routing guards: a module whose switches are all off has still
    // loaded, and that is exactly when its silence is most misleading.
    if (!announced) {
      announced = true
      if (logDecisions) {
        $.ui.log(
          `[model-router] ${describeSetup(
            active,
            url,
            {
              subagentModel: routeSubagentModel,
              mainEffort: routeMainEffort,
              mainModel: routeMainModel,
            },
            forced === 'builtin',
          )}`,
        )
      }
    }

    // A fork inherits its parent's model; `model` is ignored for it.
    if (!routeSubagentModel || e.fork) return next(e)

    if (!unusableReported) {
      unusableReported = true
      $.ui.log(`[model-router] provider "${forced}" has no key set; using the built-in classifier`)
    }

    const startedAt = await $.clock.now()
    let decision: Decision | null = null
    if (active) {
      try {
        const response = await Promise.race([
          $.http.fetch(url, {
            method: 'POST',
            headers: requestHeaders(active, apiKey, modelId),
            body: requestBody(
              active,
              { prompt: e.prompt, description: e.description, agentType: e.subagentType },
              modelId,
            ),
          }),
          $.clock.sleep(timeoutMs),
        ])
        if (response && response.ok) decision = readDecision(response.text)
        else if (response) $.ui.log(`[model-router] ${active} responded ${response.status}`)
        else $.ui.log(`[model-router] classification passed ${timeoutMs}ms; leaving the subagent alone`)
      } catch (error) {
        $.ui.log(`[model-router] classification failed: ${String(error)}`)
      }
    } else {
      try {
        // The same latency budget as a backend: past it, the subagent is left alone.
        const label = await within($.model.classify(e.prompt, TIER_ORDER), $.clock.sleep(timeoutMs))
        if (label === TIMED_OUT) {
          $.ui.log(`[model-router] classification passed ${timeoutMs}ms; leaving the subagent alone`)
        } else if (label) {
          decision = {
            tier: label as Tier,
            confidence: null,
            risky: null,
            effort: null,
            effortConfidence: null,
          }
        }
      } catch (error) {
        $.ui.log(`[model-router] built-in classifier failed: ${String(error)}`)
      }
    }

    if (logDecisions) {
      const ms = (await $.clock.now()) - startedAt
      $.ui.log(`[model-router] jev (${e.subagentType}): ${describeDecision(decision, ms)}`)
    }

    // The subagent's own model wins when the caller named one; otherwise it
    // would inherit the parent's, so that is what a change is measured from.
    // The Agent tool takes no effort, so only the model is ours to set here.
    const current = e.model ?? e.parentModel
    const { model, reason } = route(decision, { model: current }, policy)
    if (!model) {
      if (logDecisions) $.ui.log(`[model-router] ${e.subagentType}: ${reason}`)
      return next(e)
    }
    if (logDecisions) $.ui.log(`[model-router] ${e.subagentType} → ${model}: ${reason}`)
    return next({ ...e, model })
  })
}
