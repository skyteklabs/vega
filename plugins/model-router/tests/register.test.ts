import { expect, mock, test } from 'claude-code/testing'

// A fake TypeSafe reply good enough to clear readDecision without mattering:
// these tests are about which key reaches the request, not the routing it
// leads to.
const fakeReply = { value: { status: 200, ok: true, headers: {}, text: '{}' } }

const prompt = { text: 'implement the thing', wait: false, origin: { kind: 'composer' } } as const

const spawn = {
  tool_use_id: 'call-1',
  prompt: 'implement the thing',
  description: 'implement the thing',
  subagentType: 'general-purpose',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'claude-opus-5',
  background: false,
  fork: false,
} as const

/** Answers the one `http.fetch` the router is expected to make, and returns
 * the Authorization header it carried. */
function capturedAuthorization(on: Parameters<typeof mock.env>[0]) {
  let authorization: string | undefined
  on('http.fetch', async (_$, e, _next) => {
    authorization = (e.init?.headers as Record<string, string> | undefined)?.authorization
    return fakeReply
  })
  // Nothing beneath the plugins answers prompt.submit or agent.spawn under
  // test; these are the terminal hooks a real session's engine would be.
  on('prompt.submit', async (_$, e, _next) => e)
  on('agent.spawn', async (_$, e, _next) => ({ model: e.model ?? e.parentModel }))
  return () => authorization
}

test(
  'TYPESAFE_API_KEY is used when options.typesafeApiKey is unset',
  { options: { provider: 'typesafe' } },
  async ($, on) => {
    mock.env(on, { TYPESAFE_API_KEY: 'env-key' })
    mock.clock(on)
    const authorization = capturedAuthorization(on)
    await $.prompt.submit(prompt)
    expect(authorization()).toBe('Bearer env-key')
  },
)

test(
  'options.typesafeApiKey wins over TYPESAFE_API_KEY when both are set',
  { options: { provider: 'typesafe', typesafeApiKey: 'options-key' } },
  async ($, on) => {
    mock.env(on, { TYPESAFE_API_KEY: 'env-key' })
    mock.clock(on)
    const authorization = capturedAuthorization(on)
    await $.prompt.submit(prompt)
    expect(authorization()).toBe('Bearer options-key')
  },
)

// With neither key set, the router falls through to the built-in classifier
// rather than posting anywhere, so no `http.fetch` should fire at all.
test(
  'with neither key set, nothing is posted to TypeSafe',
  { options: { provider: 'typesafe' } },
  async ($, on) => {
    mock.env(on, {})
    mock.clock(on)
    const authorization = capturedAuthorization(on)
    await $.prompt.submit(prompt)
    expect(authorization()).toBeUndefined()
  },
)

// The env fallback is resolved once, lazily, the first time either hook
// runs; agent.spawn needs its own check, since prompt.submit never ran here.
test(
  'TYPESAFE_API_KEY is used on the agent.spawn path too',
  { options: { provider: 'typesafe' } },
  async ($, on) => {
    mock.env(on, { TYPESAFE_API_KEY: 'env-key' })
    mock.clock(on)
    const authorization = capturedAuthorization(on)
    await $.agent.spawn(spawn)
    expect(authorization()).toBe('Bearer env-key')
  },
)

test(
  'options.typesafeApiKey wins over TYPESAFE_API_KEY on the agent.spawn path too',
  { options: { provider: 'typesafe', typesafeApiKey: 'options-key' } },
  async ($, on) => {
    mock.env(on, { TYPESAFE_API_KEY: 'env-key' })
    mock.clock(on)
    const authorization = capturedAuthorization(on)
    await $.agent.spawn(spawn)
    expect(authorization()).toBe('Bearer options-key')
  },
)

// With no key, the built-in classifier is asked the effort rubric beside the
// tier, so the main loop's effort has a score to route on, capped at high.
test(
  'the built-in classifier routes the main loop effort, capped at high',
  { options: { provider: 'builtin' } },
  async ($, on) => {
    mock.env(on, {})
    mock.clock(on)
    on('model.classify', async (_$, e, _next) => ({
      value: e.labels.includes('deep') ? 'deep' : 'needs as much reasoning as possible',
    }))
    on('prompt.submit', async (_$, e, _next) => e)
    let sent: string | number | undefined
    on('turn.step', async function* (_$, e, _next) {
      sent = e.effort
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
    })
    await $.prompt.submit(prompt)
    const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5', effort: 'medium', messageCount: 1 })
    for await (const _chunk of stream) {
      // drained only so the result settles
    }
    await stream.result
    expect(sent).toBe('high')
  },
)

// A classifier still out at timeoutMs leaves the turn as the engine built it.
test(
  'a built-in classification past timeoutMs leaves the turn alone',
  { options: { provider: 'builtin', timeoutMs: 800 } },
  async ($, on) => {
    mock.env(on, {})
    const clock = mock.clock(on)
    on('model.classify', async (_$, _e, _next) => new Promise(() => {}))
    on('prompt.submit', async (_$, e, _next) => e)
    let sent: string | number | undefined
    on('turn.step', async function* (_$, e, _next) {
      sent = e.effort
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] } as never
    })
    const submitted = $.prompt.submit(prompt)
    await clock.advance(800)
    await submitted
    const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5', effort: 'medium', messageCount: 1 })
    for await (const _chunk of stream) {
      // drained only so the result settles
    }
    await stream.result
    expect(sent).toBe('medium')
  },
)

test(
  'the built-in classifier skips the effort question when effort routing is off',
  { options: { provider: 'builtin', routeMainEffort: false } },
  async ($, on) => {
    mock.env(on, {})
    mock.clock(on)
    const asked: (readonly string[])[] = []
    on('model.classify', async (_$, e, _next) => {
      asked.push(e.labels)
      return { value: 'deep' }
    })
    on('prompt.submit', async (_$, e, _next) => e)
    await $.prompt.submit(prompt)
    expect(asked.length).toBe(1)
  },
)

// The subagent path keeps the same budget: a classifier still out at
// timeoutMs leaves the subagent on the model it would have run on.
test(
  'a built-in classification past timeoutMs leaves the subagent alone',
  { options: { provider: 'builtin', timeoutMs: 800 } },
  async ($, on) => {
    mock.env(on, {})
    const clock = mock.clock(on)
    on('model.classify', async (_$, _e, _next) => new Promise(() => {}))
    let spawnedWith: string | undefined
    on('agent.spawn', async (_$, e, _next) => {
      spawnedWith = e.model ?? e.parentModel
      return { model: spawnedWith }
    })
    const spawned = $.agent.spawn(spawn)
    await clock.advance(800)
    await spawned
    expect(spawnedWith).toBe('claude-opus-5')
  },
)
