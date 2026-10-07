import { expect, mock, test, type Engine } from 'claude-code/testing'
import type { On, SessionMessage } from 'claude-code'

const ENGINE = { plugin: 'engine', tier: 'core' } as const
const MINUTE = 60_000

function spawnOf(id: string, description: string) {
  return {
    tool_use_id: id,
    prompt: 'do the work',
    description,
    subagentType: 'general-purpose',
    provider: ENGINE,
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  }
}

function stubEngine(on: On, messages: readonly SessionMessage[] = []) {
  const clock = mock.clock(on)
  on('session.messages', async () => ({ value: [...messages] }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async () => ({ value: undefined }))
  on('tool.register', async () => ({ value: undefined }))
  on('session.usage', async () => ({
    value: { startedAt: 0, context: { tokens: 50_000, window: 200_000, percent: 25 }, rateLimits: [], cost: { usd: 1.5 } },
  }))
  on('agent.list', async () => ({ value: [] }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('turn.complete', async () => ({ text: '' }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.render', async ($, e) => {
    const { Text } = $.ui.resolve(e)

    return Text({ children: 'engine band' })
  })

  return clock
}

function completeOf(agentId: string, reason: 'answer' | 'error') {
  return { answer: 'ok', durationMs: 1000, isAborted: false, turnId: `turn-${agentId}`, agentId, reason }
}

// The models beneath: Sonnet answers `sonnet(prompt)`, Haiku `haiku(prompt)`,
// and every call is counted by model.
function stubModels(on: On, sonnet: (prompt: string) => string, haiku: (prompt: string) => string) {
  const calls = { sonnet: 0, haiku: 0 }
  on('model.complete', async (_$, e) => {
    const isSonnet = e.model === 'sonnet'
    if (isSonnet) calls.sonnet += 1
    else calls.haiku += 1

    return {
      value: {
        isAnswered: true as const,
        text: isSonnet ? sonnet(e.prompt) : haiku(e.prompt),
        usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })

  return calls
}

// Each model step beneath answers with what the test said last.
function stubSteps(on: On) {
  const next = { answer: 'Reading the adapter.', file: 'adapter.ts' }
  on('turn.step', async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: next.answer,
      toolUses: [{ name: 'Edit', input: { file_path: `src/${next.file}` } }],
      stopReason: 'tool_use' as const,
      usage: null,
    }
  })

  return next
}

let stepIndex = 0

async function step($: Engine, agentId: string) {
  stepIndex += 1
  for await (const _chunk of $.turn.step({ turnId: `turn-${agentId}`, index: stepIndex, model: 'claude-sonnet-5-5', messageCount: 3, agentId })) {
    // drained: the plugin keeps the step once the response is whole
  }
}

const PANE_PROPS = { title: 'Workboard', isFocused: false, bodyColumns: 90, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

test('the board tracks a batch of agents and a test run, and answers it as text', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '12 passed' }, text: '12 passed in 3s' }))

  stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await $.agent.spawn(spawnOf('t2', 'Review design'))
  await $.turn.complete(completeOf('agent-t1', 'answer'))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })

  const board = await $.tool.call({ tool: 'mcp__workboard__open_board' })
  const text = String(board.result)

  expect(text).toMatch(/1\/2 finished, 1 running, 0 failed/)
  expect(text).toMatch(/\[done\] Build adapter \| sonnet 5\.5/)
  expect(text).toMatch(/\[running\] Review design/)
  expect(text).toMatch(/PASS npm test \(12 passed\)/)
  expect(text).toMatch(/Limits: ctx 25% · 50k \/ 200k/)
})

test('the band shows while agents run and hides once the batch is done', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-opus-5-5', agentId: `agent-${e.tool_use_id}` }))
  stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))

  const props = { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} }
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ plugin: 'workboard', surface, component: 'AbovePrompt', props })
    expect(await band.find({ type: 'Text', text: /0\/1 agents/ })).toBeDefined()
    await band.unmount()
  }

  await $.turn.complete(completeOf('agent-t1', 'error'))
  const band = await $.ui.mount({ plugin: 'workboard', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await band.find({ type: 'Text', text: /agents/ })).toBeUndefined()
  await band.unmount()
})

// A 4-step flow as Sonnet describes it: text around the JSON, a progress
// figure, a check with labelled exits, and a loop back that is dropped.
const FLOW_REPLY = `Here it is:
{"steps":[
  {"id":"s1","label":"Adapter fields","state":"done","detail":"Mapped the new fields."},
  {"id":"s2","label":"Adapter tests","state":"running","progress":0.6,"detail":"3 of 5 suites pass."},
  {"id":"s3","label":"Tests pass?","state":"check"},
  {"id":"s4","label":"Design review","state":"waiting"}
],
"edges":[{"from":"s1","to":"s2"},{"from":"s2","to":"s3"},{"from":"s3","to":"s4","label":"pass"},{"from":"s4","to":"s1"}]}
Hope that helps {}`

const FLOW_ASCII = [
  '        [ Adapter fields (done) ] > [ Adapter tests (run 60%) ]',
  '                                                 v',
  '                                          < Tests pass? >',
  '                                                 v pass',
  '                                     [ Design review (wait) ]',
].join('\n')

// The main conversation beneath: the person's request, a subagent hand-back,
// a reply that ran a tool, and a tool result the conversation text leaves out.
const CONVERSATION: SessionMessage[] = [
  { role: 'user', text: 'Build the adapter and review it <system-reminder>secret plumbing</system-reminder>', toolUses: [] },
  { role: 'user', text: '<agent-message from="builder">done with the adapter</agent-message>', toolUses: [] },
  { role: 'assistant', text: 'Spawning a builder and a reviewer.', toolUses: [{ tool_use_id: 'a', tool: 'Agent', input: { description: 'Build adapter' } }] },
  { role: 'user', text: 'tool output nobody should read', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'tool output nobody should read', isError: false }] },
]

// The Raster's cells as plain characters, one string per row.
function rasterRows(found: { props: Record<string, unknown> } | undefined): string[] {
  const columns = Number(found?.props.columns)
  const rows = Number(found?.props.rows)
  const bytes = Uint8Array.from(atob(String(found?.props.cells)), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  const out: string[] = []
  for (let r = 0; r < rows; r += 1) {
    let line = ''
    for (let c = 0; c < columns; c += 1) line += String.fromCodePoint(words[(r * columns + c) * 3] ?? 32)
    out.push(line)
  }

  return out
}

// The colours of the cell under the first character of `text` in a Raster.
function cellColors(found: { props: Record<string, unknown> } | undefined, text: string): { fg: number; bg: number } {
  const lines = rasterRows(found)
  const columns = Number(found?.props.columns)
  const bytes = Uint8Array.from(atob(String(found?.props.cells)), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  const row = lines.findIndex(l => l.includes(text))
  const col = lines[row]?.indexOf(text) ?? 0
  const i = (row * columns + col) * 3

  return { fg: words[i + 1] ?? 0, bg: words[i + 2] ?? 0 }
}

test('the pane footer is one plain ↻ button: no agent rows, Main row, usage or other controls', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-opus-5-5', agentId: `agent-${e.tool_use_id}` }))
  stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))

  const props = { ...PANE_PROPS, bodyColumns: 70 }
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'workboard', surface, component: 'Pane', requestId: 'workboard', props })
    for (const gone of [/^Main$|idle/, /^Agents$/, /Build adapter/, /^Tests$/, /^Recent$/, /^Limits$/, /^Flow$/, /^Overview$/, /25%/, /every/]) {
      expect(await pane.find({ type: 'Text', text: gone })).toBeUndefined()
    }
    const buttons = await pane.findAll({ type: 'Button' })
    expect(buttons.map(b => [b.key, b.props.label, b.props.hotkey, b.props.plain])).toEqual([['refresh', '↻', 'r', true]])
    const texts = (await pane.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.at(-1)).toBe('no summary yet: it comes once there is work on the board')
    await pane.unmount()
  }
})

test('Sonnet describes the flow and the terminal draws it as coloured Raster cards', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  const prompts = { sonnet: '', haiku: '' }
  const calls = stubModels(
    on,
    prompt => {
      prompts.sonnet = prompt

      return FLOW_REPLY
    },
    prompt => {
      prompts.haiku = prompt

      return 'The adapter is built and its tests are running in adapter.ts; nothing needs you'
    },
  )
  stubSteps(on)
  const clock = stubEngine(on, CONVERSATION)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await $.agent.spawn(spawnOf('t2', 'Review design'))
  await step($, 'agent-t1')
  await step($, 'agent-t2')

  // Nothing is spent before the pane is open.
  await clock.advance(10_000)
  expect(calls).toEqual({ sonnet: 0, haiku: 0 })

  const pane = await $.ui.mount({ plugin: 'workboard', surface: 'terminal', component: 'Pane', requestId: 'workboard', props: { ...PANE_PROPS, bodyColumns: 62 } })
  await clock.advance(2000)
  expect(calls).toEqual({ sonnet: 1, haiku: 1 })

  // Both read the person's conversation (no hand-backs, reminders or tool
  // output), the board and every piece of work in detail, and no usage.
  for (const prompt of [prompts.sonnet, prompts.haiku]) {
    expect(prompt).toMatch(/person: Build the adapter and review it\nclaude: Spawning a builder and a reviewer\. \[ran Agent \(Build adapter\)\]/)
    expect(prompt).not.toMatch(/secret plumbing|tool output nobody should read|done with the adapter/)
    expect(prompt).toMatch(/\[running\] Build adapter, \d+s, 0 tools\nTask: Build adapter\ndo the work\n1\. said: Reading the adapter\.; called Edit \(adapter\.ts\)/)
    expect(prompt).not.toMatch(/Limits|ctx|\$1\.50|tokens/)
  }
  expect(prompts.haiku).toContain(`The current flow, top to bottom:\n${FLOW_ASCII}`)

  const raster = await pane.find({ type: 'Raster' })
  expect(raster?.props.columns).toBe(60)
  expect(Number(raster?.props.rows)).toBeLessThanOrEqual(12)
  const rows = rasterRows(raster)
  expect(rows).toEqual([
    '   ✓ Adapter fields  ▶  ● Adapter tests  ▶  ◆ Tests pass?   ',
    '                                                  ▼ pass    ',
    '                                           ○ Design review  ',
  ])
  expect(cellColors(raster, 'Adapter fields')).toEqual({ fg: 0xffffff, bg: 0x2e7d32 })
  // 60% of the running card is filled from the left; the rest is pale.
  expect(cellColors(raster, 'Adapter tests')).toEqual({ fg: 0x0b1f24, bg: 0x26c6da })
  expect(cellColors(raster, 'tests ')).toEqual({ fg: 0x0b1f24, bg: 0xb2ebf2 })
  expect(cellColors(raster, 'Tests pass?')).toEqual({ fg: 0x1a1a1a, bg: 0xffb300 })
  expect(cellColors(raster, 'Design review')).toEqual({ fg: 0xffffff, bg: 0x546e7a })
  expect(cellColors(raster, '▶')).toEqual({ fg: 0x8a8f98, bg: 0x01000000 })
  console.log(`Raster sample (${raster?.props.columns}x${raster?.props.rows}):\n${rows.map(r => `|${r}|`).join('\n')}`)
  await pane.unmount()

  const board = String((await $.tool.call({ tool: 'mcp__workboard__open_board' })).result)
  expect(board).toContain(`Flow:\n${FLOW_ASCII}\nSummary:\nThe adapter is built and its tests are running in adapter.ts\nnothing needs you`)
})

test('the desktop draws the flow as a small interactive Svg, other surfaces as ASCII', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  stubModels(on, () => FLOW_REPLY, () => 'The adapter tests are running; nothing needs you')
  stubSteps(on)
  const clock = stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await $.tool.call({ tool: 'mcp__workboard__open_board' })
  await clock.advance(2000)

  const desktop = await $.ui.mount({ plugin: 'workboard', surface: 'desktop', component: 'Pane', requestId: 'workboard', props: PANE_PROPS })
  const svg = await desktop.find({ type: 'Svg' })
  expect(svg?.props.isInteractive).toBe(true)
  expect(Number(svg?.props.width)).toBeLessThanOrEqual(480)
  expect(Number(svg?.props.height)).toBeLessThanOrEqual(80)
  expect(String(svg?.props.alt)).toBe('Flow of the job, top to bottom: Adapter fields (done), Adapter tests (running), Tests pass? (check), Design review (waiting)')
  const source = String(svg?.props.source)
  expect(source).toMatch(/^<svg /)
  expect(source).toContain('<title>Adapter tests: 3 of 5 suites pass. (running, 60%)</title>')
  expect(source).toMatch(/rx="4" fill="#2e7d32"/)
  expect(source).toMatch(/font-size="10"/)
  expect(source).toMatch(/marker-end="url\(#arrow\)"/)
  expect(source).not.toMatch(/stroke-width="(?!1")/)
  expect(await desktop.find({ type: 'Raster' })).toBeUndefined()
  await desktop.unmount()

  for (const surface of ['vscode', 'mobile'] as const) {
    const pane = await $.ui.mount({ plugin: 'workboard', surface, component: 'Pane', requestId: 'workboard', props: { ...PANE_PROPS, bodyColumns: 74 } })
    expect((await pane.find({ type: 'Code' }))?.props.source).toBe(FLOW_ASCII)
    await pane.unmount()
  }
})

// The summary rows: the paragraph and, when there is one, the italic next row.
async function summaryTexts($: Engine, bodyColumns: number) {
  const pane = await $.ui.mount({ plugin: 'workboard', surface: 'terminal', component: 'Pane', requestId: 'workboard', props: { ...PANE_PROPS, bodyColumns } })
  const texts = await pane.findAll({ type: 'Text' })
  await pane.unmount()

  return texts
}

test('a trailing next clause becomes its own italic row under the summary', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  stubModels(on, () => FLOW_REPLY, () => 'Summary: The adapter tests failed in adapter.test.ts and the review\nwaits on them; next: review the diagram')
  stubSteps(on)
  const clock = stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await $.tool.call({ tool: 'mcp__workboard__open_board' })
  await clock.advance(2000)

  const texts = await summaryTexts($, 90)
  expect(texts.at(-1)?.text).toBe('next: review the diagram')
  expect(texts.at(-1)?.props.italic).toBe(true)
  expect(texts.at(-2)?.text).toBe('The adapter tests failed in adapter.test.ts and the review waits on them')
  expect(texts.at(-2)?.props.italic).toBeUndefined()
  expect(texts.filter(t => t.props.italic === true)).toHaveLength(1)

  const board = String((await $.tool.call({ tool: 'mcp__workboard__open_board' })).result)
  expect(board).toMatch(/Summary:\nThe adapter tests failed in adapter\.test\.ts and the review waits on them\nnext: review the diagram$/)
})

test('a multi-line reply with no next clause is one wrapped paragraph, nothing italic, no ellipsis', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  const reply = [
    'The Workboard mod is getting flow diagram graphics and italic next-line formatting.',
    'A subagent is building both in parallel, with coloured cards and arrows instead of ASCII,',
    'and moving the next line into italics.',
  ]
  stubModels(on, () => FLOW_REPLY, () => reply.join('\n'))
  stubSteps(on)
  const clock = stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await $.agent.spawn(spawnOf('t2', 'Review design'))
  await $.tool.call({ tool: 'mcp__workboard__open_board' })
  await clock.advance(2000)

  const texts = await summaryTexts($, 60)
  const last = texts.at(-1)
  expect(last?.text).toBe(reply.join(' '))
  expect(last?.props.wrap).toBe('wrap')
  expect(last?.props.italic).toBeUndefined()
  expect(texts.filter(t => t.props.italic === true)).toHaveLength(0)
  expect(texts.some(t => t.text.includes('…'))).toBe(false)
})

test('a long summary at a narrow pane wraps in full, and the word cap cuts at a sentence', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  const prompts: string[] = []
  const sentences = [
    'The adapter is built and its tests run in adapter.test.ts.',
    'Review of the design waits on those tests, and the docs stream is idle while types are checked.',
    'Further detail goes on about many other things well past the budget for this one summary.',
  ]
  stubModels(
    on,
    () => FLOW_REPLY,
    prompt => {
      prompts.push(prompt)

      return `${sentences.join('\n')}\nnothing needs you`
    },
  )
  stubSteps(on)
  const clock = stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await $.tool.call({ tool: 'mcp__workboard__open_board' })
  await clock.advance(2000)
  expect(prompts[0]).toMatch(/Budget: 1 subagent running, so at most 1 line and 30 words of summary, then the next line\.$/)

  // 1 running: 30 words, cut at the last sentence that fits, no ellipsis.
  const one = await summaryTexts($, 60)
  expect(one.at(-2)?.text).toBe(`${sentences[0]} ${sentences[1]}`)
  expect(one.at(-2)?.props.wrap).toBe('wrap')
  expect(one.at(-1)?.text).toBe('nothing needs you')
  expect(one.at(-1)?.props.italic).toBe(true)
  expect(one.some(t => t.text.includes('…'))).toBe(false)

  // 4 running: 70 words, so all of it.
  await $.agent.spawn(spawnOf('t2', 'Review design'))
  await $.agent.spawn(spawnOf('t3', 'Write docs'))
  await $.agent.spawn(spawnOf('t4', 'Check types'))
  const controls = await $.ui.mount({ plugin: 'workboard', surface: 'terminal', component: 'Pane', requestId: 'workboard', props: PANE_PROPS })
  await controls.press({ key: 'refresh' })
  await controls.unmount()
  await clock.advance(2000)
  expect(prompts[1]).toMatch(/Budget: 4 subagents running, so at most 3 lines and 70 words of summary, then the next line\.$/)
  const four = await summaryTexts($, 60)
  expect(four.at(-2)?.text).toBe(sentences.join(' '))
})

test('a finished batch reruns both at once, ignoring the timers', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  const calls = stubModels(on, () => FLOW_REPLY, () => 'Building the adapter; nothing needs you')
  stubSteps(on)
  const clock = stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await step($, 'agent-t1')
  await $.tool.call({ tool: 'mcp__workboard__open_board' })
  await clock.advance(2000)
  expect(calls).toEqual({ sonnet: 1, haiku: 1 })

  await $.turn.complete(completeOf('agent-t1', 'answer'))
  await clock.advance(2000)
  expect(calls).toEqual({ sonnet: 2, haiku: 2 })
})

test('only the person\'s own prompts make the job; hand-backs and notices keep it', async ($, on) => {
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('prompt.submit', async (_$, e) => ({ text: e.text, origin: e.origin }))
  const prompts: string[] = []
  stubModels(
    on,
    prompt => {
      prompts.push(prompt)

      return FLOW_REPLY
    },
    () => 'The board pane is getting its summary; nothing needs you',
  )
  const clock = stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'Add summaries to the board pane', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'Add summaries to the board pane', turnId: 'turn-1' })
  await $.prompt.submit({ text: 'Build finished, here is my report', wait: false, origin: { kind: 'task-notification' } })
  await $.turn.start({ text: 'Build finished, here is my report', turnId: 'turn-2' })
  await $.turn.start({ text: '<agent-message from="worker">done</agent-message>', turnId: 'turn-3' })
  await $.turn.start({ text: 'Now make the text wrap', turnId: 'turn-4' })
  await $.turn.start({ text: '', turnId: 'turn-5' })
  await $.tool.call({ tool: 'mcp__workboard__open_board' })
  await clock.advance(2000)

  expect(prompts[0]).toMatch(/Job \(the person's latest requests, newest last\):\n- Add summaries to the board pane\n- Now make the text wrap\n/)
  expect(prompts[0]).not.toMatch(/here is my report|agent-message/)
  expect(prompts[0]).toMatch(/\[running\] Main turn[^\n]*\nTask: The person asked: Now make the text wrap/)
})

test('a continued agent keeps its first start and adds up its active time; tests show the invocation alone', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '3 passed' }, text: '3 passed' }))
  stubSteps(on)
  const clock = stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await step($, 'agent-t1')
  await clock.advance(5 * MINUTE)
  await $.turn.complete(completeOf('agent-t1', 'answer'))
  await clock.advance(30 * MINUTE)
  await step($, 'agent-t1')
  await clock.advance(5 * MINUTE)
  await $.turn.complete(completeOf('agent-t1', 'answer'))
  await $.tool.call({
    tool: 'Bash',
    command: 'cd /c/work/app && FORCE_COLOR=0 npx vitest run src/adapters/very/long/path/adapter.test.ts --reporter verbose | tee out.log',
  })

  const board = String((await $.tool.call({ tool: 'mcp__workboard__open_board' })).result)
  expect(board).toMatch(/\[done\] Build adapter \| sonnet 5\.5 \| 40m00s elapsed, 10m00s active over 2 runs \|/)
  expect(board).toContain('- PASS npx vitest run src/adapters/very/long/path/adapter.test.ts… (3 passed)')
  expect(board).not.toMatch(/cd \/c\/work|tee out\.log|FORCE_COLOR/)
})

test('subagents spawned by a subagent are left out of the work and do not finish their parent', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  const prompts: string[] = []
  stubModels(
    on,
    prompt => {
      prompts.push(prompt)

      return FLOW_REPLY
    },
    () => 'The adapter is being built; nothing needs you',
  )
  const answers = stubSteps(on)
  const clock = stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await $.agent.spawn({ ...spawnOf('n1', 'Scan helper files'), parentAgentId: 'agent-t1' })
  await $.agent.spawn({ ...spawnOf('n2', 'Scan deeper'), parentAgentId: 'agent-n1' })
  await step($, 'agent-t1')
  answers.answer = 'A nested agent talking.'
  await step($, 'agent-n2')
  await $.turn.complete(completeOf('agent-n1', 'answer'))

  await $.tool.call({ tool: 'mcp__workboard__open_board' })
  await clock.advance(2000)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).not.toMatch(/Scan helper files|Scan deeper|nested agent talking/)
  expect(prompts[0]).toMatch(/\[running\] Build adapter/)

  const board = String((await $.tool.call({ tool: 'mcp__workboard__open_board' })).result)
  expect(board).toMatch(/0\/1 finished, 1 running/)
  expect(board).not.toMatch(/Scan helper files|Scan deeper/)
})

test('rounds are skipped while nothing changes, and run again once something does', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  const calls = stubModels(on, () => FLOW_REPLY, () => 'Building the adapter; nothing needs you')
  stubSteps(on)
  const clock = stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await step($, 'agent-t1')
  await $.tool.call({ tool: 'mcp__workboard__open_board' })
  await clock.advance(2000)
  expect(calls).toEqual({ sonnet: 1, haiku: 1 })

  await clock.advance(90 * MINUTE)
  expect(calls).toEqual({ sonnet: 1, haiku: 1 })

  await step($, 'agent-t1')
  await clock.advance(2000)
  expect(calls).toEqual({ sonnet: 2, haiku: 2 })
})

test('both rerun every 15 minutes when something changed, and ↻ refreshes both at once', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  let round = 0
  const calls = stubModels(
    on,
    () => `{"steps":[{"id":"a","label":"Round ${round}","state":"running"}],"edges":[]}`,
    () => `Summary ${round}; nothing needs you`,
  )
  stubSteps(on)
  const clock = stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await step($, 'agent-t1')
  await $.tool.call({ tool: 'mcp__workboard__open_board' })
  await clock.advance(2000)
  expect(calls).toEqual({ sonnet: 1, haiku: 1 })

  // 10 minutes on, with a new step: neither is due yet.
  round = 1
  await step($, 'agent-t1')
  await clock.advance(10 * MINUTE)
  expect(calls).toEqual({ sonnet: 1, haiku: 1 })

  // 15 minutes after the first round: both are due, the flow first.
  await clock.advance(5 * MINUTE + 2000)
  expect(calls).toEqual({ sonnet: 2, haiku: 2 })

  // Nothing changed for another 15 minutes: neither runs.
  await clock.advance(16 * MINUTE)
  expect(calls).toEqual({ sonnet: 2, haiku: 2 })

  const pane = await $.ui.mount({ plugin: 'workboard', surface: 'terminal', component: 'Pane', requestId: 'workboard', props: PANE_PROPS })
  expect(rasterRows(await pane.find({ type: 'Raster' })).join('\n')).toMatch(/● Round 1/)

  // ↻ ignores the timers and the skip check.
  round = 2
  await pane.press({ key: 'refresh' })
  await clock.advance(2000)
  expect(calls).toEqual({ sonnet: 3, haiku: 3 })
  expect(rasterRows(await pane.find({ type: 'Raster' })).join('\n')).toMatch(/● Round 2/)
  expect((await pane.findAll({ type: 'Text' })).map(t => t.text).slice(-2)).toEqual(['Summary 2', 'nothing needs you'])
  await pane.unmount()
})

test('↻ counts down only in the last minute before a round that would run, and shows … while one runs', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  let isSlow = false
  const clock = stubEngine(on)
  const calls = { haiku: 0 }
  on('model.complete', async (_$, e) => {
    if (e.model === 'haiku') calls.haiku += 1
    if (isSlow) await clock.sleep(10_000)

    return {
      value: {
        isAnswered: true as const,
        text: e.model === 'sonnet' ? FLOW_REPLY : 'Building the adapter; nothing needs you',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  stubSteps(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await step($, 'agent-t1')
  const pane = await $.ui.mount({ plugin: 'workboard', surface: 'terminal', component: 'Pane', requestId: 'workboard', props: PANE_PROPS })
  const label = async () => (await pane.find({ type: 'Button', key: 'refresh' }))?.props.label
  await clock.advance(1000)
  expect(calls.haiku).toBe(1)

  // Nothing changed since: bare ↻, even in the last minute.
  await clock.advance(14 * MINUTE + 30_000)
  expect(await label()).toBe('↻')

  // Something changed: the countdown shows under 60 s, and moves each second.
  await step($, 'agent-t1')
  await clock.advance(1000)
  expect(await label()).toBe('↻ 29s')
  await clock.advance(3000)
  expect(await label()).toBe('↻ 26s')

  // Further than a minute out: bare ↻ again after the round ran.
  await clock.advance(30_000)
  expect(calls.haiku).toBe(2)
  await step($, 'agent-t1')
  await clock.advance(1000)
  expect(await label()).toBe('↻')

  // A slow round shows ↻ … until it answers.
  isSlow = true
  await pane.press({ key: 'refresh' })
  await clock.advance(1000)
  expect(await label()).toBe('↻ …')
  await clock.advance(25_000)
  expect(await label()).toBe('↻')
  await pane.unmount()
})

// $.state beneath the plugin, as the host keeps it across a reload: a map the
// test can seed (what the module before the reload wrote) and read.
function mockState(on: On, seed: Record<string, unknown> = {}) {
  const kept = new Map<string, { value: unknown; version: number }>(Object.entries(seed).map(([k, v]) => [k, { value: v, version: 1 }]))
  on('state.get', async (_$, e) => ({ value: kept.get(e.key) ?? { value: undefined, version: 0 } }) as never)
  on('state.set', async (_$, e) => {
    const version = (kept.get(e.key)?.version ?? 0) + 1
    kept.set(e.key, { value: e.value, version })

    return { value: { isSet: true, version } } as never
  })

  return kept
}

test('the records are written to $.state on the next tick', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  const kept = mockState(on)
  stubSteps(on)
  const clock = stubEngine(on)
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnOf('t1', 'Build adapter'))
  await step($, 'agent-t1')
  await clock.advance(1000)

  const agents = kept.get('agents')?.value as { description: string; steps: string[]; runs: number }[] | undefined
  expect(agents?.[0]?.description).toBe('Build adapter')
  expect(agents?.[0]?.steps).toEqual(['said: Reading the adapter.; called Edit (adapter.ts)'])
  expect(agents?.[0]?.runs).toBe(1)
  expect(kept.get('batch')?.value).toEqual(['t1'])
  expect(kept.get('rounds')?.value).toMatchObject({ flowAt: null, summaryAt: null })
})

test('a fresh module (a hot reload) loads the kept records before it draws or counts', async ($, on) => {
  on('agent.spawn', async (_$, e) => ({ model: 'claude-sonnet-5-5', agentId: `agent-${e.tool_use_id}` }))
  // What the module before the reload wrote: an agent 35 minutes in, 25 tools.
  mockState(on, {
    agents: [
      {
        id: 'agent-t1', key: 't1', description: 'Build adapter', type: 'general-purpose', model: 'sonnet 5.5', status: 'running',
        task: 'Build adapter', steps: [], startedAt: 5 * MINUTE, runStartedAt: 30 * MINUTE, activeMs: 20 * MINUTE, runs: 2,
        tools: 25, last: 'Edit adapter.ts', lastAt: 39 * MINUTE,
      },
    ],
    batch: ['t1'],
    job: { requests: ['Build the adapter'], task: 'The person asked: Build the adapter' },
  })
  const clock = stubEngine(on)
  await clock.set(40 * MINUTE)

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  const board = String((await $.tool.call({ tool: 'mcp__workboard__open_board' })).result)
  expect(board).toMatch(/\[running\] Build adapter \| sonnet 5\.5 \| 35m00s elapsed, 30m00s active over 2 runs \| 25 tools/)
  expect(board).toMatch(/Job \(the person's latest requests, newest last\):\n- Build the adapter/)
})
