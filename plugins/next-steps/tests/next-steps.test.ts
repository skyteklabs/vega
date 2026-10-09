import type { CommandInfo, ModelForkResult, On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

// An answer long enough to be suggested after (minAnswerChars defaults to 80).
const LONG = 'Done. I added the parser, wired it into the CLI, and wrote tests for the happy path and the two error cases.'

const COMMANDS: CommandInfo[] = [
  { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
  { name: 'code-review', description: 'Review the current diff', source: 'plugin', plugin: 'code-review' },
  { name: 'deploy', description: 'Ship it to staging', source: 'user' },
]

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }

type World = { forks: string[]; filled: string[]; suggested: string[]; toasts: string[]; logs: string[] }

/** The engine beneath the plugin: the fork answers `reply`, the prompt box takes what it is handed. */
function engine(
  on: On,
  reply: string | ModelForkResult | Error | (() => Promise<string>),
  opts: { commands?: CommandInfo[] | Error; isFilled?: boolean } = {},
): World {
  const w: World = { forks: [], filled: [], suggested: [], toasts: [], logs: [] }
  const commands = opts.commands ?? COMMANDS
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.list', () => (commands instanceof Error ? { deny: commands.message } : { value: commands }))
  on('model.fork', async (_$, e) => {
    w.forks.push(e.prompt)
    if (reply instanceof Error) return { deny: reply.message }
    if (typeof reply === 'function') return { value: { isAnswered: true, text: await reply(), usage: USAGE } }
    return { value: typeof reply === 'string' ? { isAnswered: true, text: reply, usage: USAGE } : reply }
  })
  on('prompt.suggest', (_$, e) => {
    w.suggested.push(e.text)
    return { isShown: true }
  })
  on('prompt.fill', (_$, e) => {
    w.filled.push(e.text)
    return { isFilled: opts.isFilled ?? true }
  })
  on('ui.toast', (_$, e) => {
    w.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('ui.log', (_$, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  // What other plugins draw in the band: next-steps keeps it and adds below.
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'Text' as const, props: {}, children: ['below'] }))
  return w
}

const band = (props: { isWorking?: boolean; hasSurvey?: boolean } = {}) => ({
  plugin: 'next-steps',
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: props.hasSurvey ?? false,
    isWorking: props.isWorking ?? false,
    maxRows: 12,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
})

let turnN = 0
/** One whole turn: started, completed, and the detached fork let run to its end. */
async function turn($: Engine, clock: MockClock, answer = LONG, reason: 'answer' | 'aborted' | 'error' = 'answer') {
  const turnId = `t${++turnN}`
  await $.turn.start({ text: 'go', turnId })
  await $.turn.complete({ reason, answer, durationMs: 1000, isAborted: reason === 'aborted', turnId })
  await clock.settle()
  return turnId
}

const reply = (items: unknown) => JSON.stringify(items)

const THREE = reply([
  { label: 'Run the tests', prompt: 'run the parser tests' },
  { label: 'Same for the lexer', prompt: 'do the same for the lexer' },
  { label: 'Review', prompt: '/code-review high' },
])

test('after a long answer, up to three suggestions draw as buttons; the top one becomes ghost text', async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, THREE)
  await turn($, clock)
  expect(w.forks).toHaveLength(1)
  expect(w.suggested).toEqual(['run the parser tests'])
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /^below$/ })).toBeDefined()
  expect(await ui.find({ text: /^next:$/ })).toBeDefined()
  expect((await ui.find({ key: 'pick-1' }))?.text).toBe('Run the tests')
  expect((await ui.find({ key: 'pick-2' }))?.text).toBe('Same for the lexer')
  expect((await ui.find({ key: 'pick-3' }))?.text).toBe('Review')
  expect(await ui.find({ key: 'dismiss' })).toBeDefined()
  await ui.unmount()
})

test('a press fills the prompt box with the full prompt, never submits, and hides the band', async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, THREE)
  await turn($, clock)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  await ui.press({ key: 'pick-2' })
  expect(w.filled).toEqual(['do the same for the lexer'])
  expect(w.toasts).toEqual([])
  expect(await ui.find({ text: /^next:$/ })).toBeUndefined()
  await ui.unmount()
})

test('a fill the box refuses is reported in a toast', async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, THREE, { isFilled: false })
  await turn($, clock)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  await ui.press({ key: 'pick-1' })
  await clock.settle()
  expect(w.toasts).toEqual(['could not fill the prompt box'])
  await ui.unmount()
})

test('0 dismisses without filling anything', async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, THREE)
  await turn($, clock)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  await ui.press({ key: 'dismiss' })
  expect(w.filled).toEqual([])
  expect(await ui.find({ key: 'pick-1' })).toBeUndefined()
  await ui.unmount()
})

test('the next turn hides what was offered', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, THREE)
  await turn($, clock)
  await $.turn.start({ text: 'run the parser tests', turnId: 'next' })
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ key: 'pick-1' })).toBeUndefined()
  expect(await ui.find({ text: /^below$/ })).toBeDefined()
  await ui.unmount()
})

test('no fork after a short answer, an aborted turn or an errored one', async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, THREE)
  await turn($, clock, 'Done.')
  await turn($, clock, LONG, 'aborted')
  await turn($, clock, LONG, 'error')
  expect(w.forks).toEqual([])
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /^next/ })).toBeUndefined()
  await ui.unmount()
})

test('minAnswerChars moves the threshold', { options: { minAnswerChars: 5 } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, THREE)
  await turn($, clock, 'Done, shipped.')
  expect(w.forks).toHaveLength(1)
})

test('while the fork thinks the band says so; a working turn or a survey keeps it hidden', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, async () => {
    await clock.sleep(1000)
    return THREE
  })
  await turn($, clock)
  const loading = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await loading.find({ text: /next steps…/ })).toBeDefined()
  await loading.unmount()
  await clock.advance(1000)
  for (const props of [{ isWorking: true }, { hasSurvey: true }]) {
    const ui = await $.ui.mount({ ...band(props), surface: 'terminal' })
    expect(await ui.find({ key: 'pick-1' })).toBeUndefined()
    expect(await ui.find({ text: /^below$/ })).toBeDefined()
    await ui.unmount()
  }
  const shown = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await shown.find({ key: 'pick-1' })).toBeDefined()
  await shown.unmount()
})

test('a fork that answers after a newer turn started is dropped', async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, async () => {
    await clock.sleep(1000)
    return THREE
  })
  await turn($, clock)
  await $.turn.start({ text: 'something else', turnId: 'newer' })
  await clock.advance(1000)
  expect(w.suggested).toEqual([])
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ key: 'pick-1' })).toBeUndefined()
  await ui.unmount()
})

test('the fork is told the plugin, user and MCP commands, never the builtins', async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, '[]')
  await turn($, clock)
  const prompt = w.forks[0] ?? ''
  expect(prompt).toContain('Do not continue the task.')
  expect(prompt).toContain('<available-skills>')
  expect(prompt).toContain('/code-review: Review the current diff')
  expect(prompt).toContain('/deploy: Ship it to staging')
  expect(prompt).not.toContain('/clear')
})

test('suggestSkills off leaves the skills out of the question', { options: { suggestSkills: false } }, async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, '[]')
  await turn($, clock)
  expect(w.forks[0]).not.toContain('<available-skills>')
})

test('a slash prompt naming a command the session lacks is dropped', async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(
    on,
    reply([
      { label: 'Made up', prompt: '/not-a-command now' },
      { label: 'Deploy', prompt: '/deploy staging' },
      { label: 'Plain', prompt: 'commit it' },
    ]),
  )
  await turn($, clock)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect((await ui.find({ key: 'pick-1' }))?.text).toBe('Deploy')
  expect((await ui.find({ key: 'pick-2' }))?.text).toBe('Plain')
  expect(await ui.find({ key: 'pick-3' })).toBeUndefined()
  expect(w.suggested).toEqual(['/deploy staging'])
  await ui.unmount()
})

test('without the command list the fork still asks, and slash prompts go unchecked', async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, reply([{ label: 'Anything', prompt: '/whatever' }]), { commands: new Error('no list') })
  await turn($, clock)
  expect(w.forks[0]).not.toContain('<available-skills>')
  expect(w.suggested).toEqual(['/whatever'])
})

test('model text is cleaned: escapes and controls stripped, tag characters refused, length capped', async ($, on) => {
  const clock = mock.clock(on)
  const tagged = `run it${String.fromCodePoint(0xe0041)}`
  const w = engine(
    on,
    'Sure! ' +
      reply([
        { label: 'Hidden', prompt: tagged },
        { label: '\x1b[31mRed\x1b[0m​ label', prompt: 'fix\tthe\n\nbug' },
        { prompt: 'x'.repeat(700) },
        { label: 'Fourth', prompt: 'never reached' },
        { label: 'Fifth', prompt: 'never reached either' },
      ]) +
      ' hope that helps',
  )
  await turn($, clock)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect((await ui.find({ key: 'pick-1' }))?.text).toBe('Red label')
  const second = (await ui.find({ key: 'pick-2' }))?.text ?? ''
  expect([...second]).toHaveLength(48) // no label: the prompt, cut to the button's width
  expect(second.endsWith('…')).toBe(true)
  expect((await ui.find({ key: 'pick-3' }))?.text).toBe('Fourth')
  expect(w.suggested).toEqual(['fix the bug'])
  await ui.press({ key: 'pick-2' })
  expect([...(w.filled[0] ?? '')]).toHaveLength(600)
  await ui.unmount()
})

test('a reply with no JSON array, an empty one, or bad JSON offers nothing', async ($, on) => {
  const clock = mock.clock(on)
  const replies = ['I think you should run the tests.', '[]', '[not json]']
  let i = 0
  const w = engine(on, async () => replies[i++] ?? '[]')
  for (let n = 0; n < replies.length; n += 1) await turn($, clock)
  expect(w.forks).toHaveLength(3)
  expect(w.suggested).toEqual([])
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /^next/ })).toBeUndefined()
  await ui.unmount()
})

test('an unanswered fork offers nothing', async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, { isAnswered: false, reason: 'nothing-to-fork' })
  await turn($, clock)
  expect(w.forks).toHaveLength(1)
  expect(w.suggested).toEqual([])
})

test('a fork that throws is logged and offers nothing', async ($, on) => {
  const clock = mock.clock(on)
  const w = engine(on, new Error('boom'))
  await turn($, clock)
  expect(w.logs.some(l => l.startsWith('fork failed:') && l.includes('boom'))).toBe(true)
  const ui = await $.ui.mount({ ...band(), surface: 'terminal' })
  expect(await ui.find({ text: /^next/ })).toBeUndefined()
  await ui.unmount()
})

test('the band draws on every surface', async ($, on) => {
  const clock = mock.clock(on)
  engine(on, THREE)
  await turn($, clock)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...band(), surface })
    expect(await ui.findAll({ type: 'Button' })).toHaveLength(4)
    await ui.unmount()
  }
})
