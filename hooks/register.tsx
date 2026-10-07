// Workboard: one live view of long-running work in this session.
//
// agent.spawn / tool.call / turn.complete: track each subagent (started,
// tool calls, last activity, finished, failed) and group the ones that run
// together into a batch, so the board can say "3/5 done, ~4m left". Only
// top-level subagents are tracked; one a subagent spawns counts as its parent's.
// tool.call on Bash / PowerShell: notice test commands and keep their result.
// session.measure: context fill, plan limits and cost, free to read; in the
// board text only, since the status line already shows them.
// prompt.submit / turn.start: the person's own prompts make the job; agent
// hand-backs, notifications and other sessions' messages do not.
// turn.step: keep each agent's last few model steps (what it said, which tools
// it called, what failed), and the main turn's too.
// Summaries, the one part that spends usage, and only while the pane is open:
// one Sonnet call at most every FLOW_MS describes the whole job as steps and
// edges, which flow.ts lays out and draws (Raster, Svg or ASCII); one Haiku
// call at most every SUMMARY_MS writes the summary at the bottom of the pane.
// Both read the conversation, the board and every agent's task and steps; each
// is skipped when nothing changed, and both rerun as soon as a batch finishes.
// The pane's one control, ↻, reruns both now and counts down the last minute.
// $.state keeps agents, the batch, the job, the flow, the summary and the
// rounds' times (types/index.d.ts), so a hot reload loses none of them.
// ui.render: a band above the prompt while agents run, and the /board pane.
// open_board: a tool Claude calls when asked for status; it opens the pane and
// answers with the same board as text, so Claude does not have to poll.
//
// The host reads on(...) and $.noun.method(...) from source, so they are
// spelled literally, and helpers that take $ are top-level functions.

import type { EngineInterface, ModelCompleteResult, PromptOrigin, Register } from 'claude-code'
import type { WorkboardAgent, WorkboardStatus, WorkboardSummary } from '../types'
import { flowRaster, flowSvg, flowText, parseFlow, type Flow } from './flow'

const PANE = 'workboard'
const TITLE = 'Workboard'
const TOOL_FULL = 'mcp__workboard__open_board'
const TICK_MS = 1000
const STEPS_KEPT = 6
const FLOW_MS = 15 * 60_000
const SUMMARY_MS = 15 * 60_000
const FLOW_SYSTEM = [
  'You map the whole job a team of coding agents is doing for one person, for a diagram they read at a glance.',
  'You get the conversation so far (what the person asked and what was done), the board (every agent, tests, recent events) and each piece of work in detail (its task and latest steps).',
  'Reply with only a JSON object: {"steps":[{"id":"s1","label":"Adapter","state":"done","detail":"Mapped the new fields in adapter.ts."}],"edges":[{"from":"s1","to":"s2"}]}.',
  'steps: 3 to 6 pieces of work toward what the person asked, in the order they happen, as one system; never more than 8: merge or summarize smaller pieces into one step rather than going past it. label: a noun phrase in the person\'s terms (the feature, fix, file or check), at most 4 words and 24 characters; no agent ids, numbers or sentences.',
  'state: done, running, failed, waiting (not started, or blocked) or check (a gate the work must pass, its label a question ending in ?). progress: only on a running step, and only when the input shows how far it is (3 of 5 files), from 0 to 1. detail: one plain sentence on what happened or is happening, for a tooltip.',
  'edges: what feeds what, top to bottom, at most 8, never back up the flow. Leave an edge unlabelled unless it leaves a check; then label it with its outcome (pass, fail). A failure is a failed step named by its outcome.',
  'Show only what the input shows. No other text.',
].join(' ')
const SUMMARY_SYSTEM = [
  'You write the summary a person reads at a glance about the whole chat: where the job they asked for stands, and what needs them.',
  'You get the conversation so far, the board (every agent, tests, recent events), the current flow and each piece of work in detail.',
  'Lead with the answer: where the job stands against what they asked, naming the work in their terms (the feature, file, fix or test). Mention what subagents are doing only as far as it explains where the job stands, one clause per stream of work, grouping agents that do the same kind of work; never one agent at a time for its own sake, and never counts for their own sake.',
  "End with 'next: ' and the one action for the person, if something needs them (a failed agent or test, work stalled for a long while, a question waiting on them), otherwise with exactly 'nothing needs you'.",
  'State only what the input shows. Plain words, no filler, no hedging, no praise, no labels or bullets. Never mention tokens, context, cost, usage, limits or percentages. Keep to the budget you are given.',
].join(' ')
const TEST_COMMAND =
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bpytest\b|\bvitest\b|\bjest\b|\bplaywright\s+test\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bInvoke-Pester\b|\bunittest\b|\bnode\s+--test\b|\bplugin\s+test\b/i
// Turn texts that are not the person speaking: subagent hand-backs, task and
// system notices, other sessions' messages.
const NOT_THE_PERSON =
  /^\s*(<(agent-message|task-notification|system-reminder|teammate-message|channel-message|cross-session|peer-message|local-command-stdout)\b|\[MESSAGE FROM NON-USER|Another Claude session|The coordinator sent|The user sent a new message while you were working|This is how Claude Code surfaces)/i

type Status = WorkboardStatus

// What the summarizers read, for a subagent and for the main turn.
type Track = { task: string; steps: string[] }

// A top-level subagent: its task and steps (a Track), its time over every run.
type Agent = WorkboardAgent

type TestRun = { command: string; ok: boolean; at: number; durationMs: number; summary: string }

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

type Usage = { tokens?: number; window: number; percent?: number; limits: Limit[]; usd?: number }

type LogLine = { at: number; status: Status; text: string }

// The summary as the pane draws it: one paragraph, then the next clause (if
// Haiku ended with one) on a row of its own, in italics.
type Summary = WorkboardSummary

type Progress = { done: number; failed: number; running: number; total: number; startedAt: number; etaMs?: number }

let agents: Agent[] = []
let batch: string[] = []
let main = { isWorking: false, turnStartedAt: 0, tools: 0, last: '', lastAt: 0, lastTurnMs: 0, hadAgents: false }
let tests: TestRun[] = []
let usage: Usage | null = null
let log: LogLine[] = []
let mainTrack: Track = newTrack('')
let requests: string[] = []
// The last prompt that entered and whether the person wrote it, from its
// origin; turn.start reads it for the turn that prompt starts.
let lastSubmit: { text: string; isPerson: boolean } | undefined
let otherTools = 0
let isPaneOpen = false
let ticks = 0
// Counts spawns, finishes, steps and test runs: a summarizer reruns only
// after it moved.
let changes = 0
// Haiku's summary (its text, and the next line split off it) and Sonnet's
// description of the whole job as steps and edges.
let summary: Summary | undefined
let flow: Flow | undefined
// Subagents spawned by a subagent, by id, to the top-level agent they work
// for: their tool calls count as its activity; no row or steps of their own.
let nested = new Map<string, string>()
let summaries = {
  isRunning: false,
  isForced: false,
  // A batch finished while the pane was closed: the next open reruns both.
  isStale: false,
  flowAt: -Infinity,
  flowChanges: -1,
  summaryAt: -Infinity,
  summaryChanges: -1,
  refreshedAt: -Infinity,
  failures: 0,
}

// The records that survive a hot reload, in $.state (types/index.d.ts): the
// module keeps its working copy, loads them once on its first hook after a
// load, and writes them back on the tick after anything changed.
const AGENTS = { plugin: 'workboard', key: 'agents' } as const
const BATCH = { plugin: 'workboard', key: 'batch' } as const
const JOB = { plugin: 'workboard', key: 'job' } as const
const FLOW = { plugin: 'workboard', key: 'flow' } as const
const SUMMARY = { plugin: 'workboard', key: 'summary' } as const
const ROUNDS = { plugin: 'workboard', key: 'rounds' } as const
let restoring: Promise<void> | undefined
let isDirty = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await restore($)
    const result = await next(e)
    await $.command.register({
      name: 'board',
      description: 'Open the Workboard: live progress of subagents, tests, context and plan limits',
    })
    await $.tool.register({
      name: 'open_board',
      description:
        'Open the Workboard pane for the user and get the same board as text: every subagent of this session (running, done, failed, elapsed, tool calls, last activity), batch progress with a time estimate, the main turn, recent test runs, context fill, plan limits, cost, a flow diagram of the whole job and a summary of where it stands. Call it when the user asks for status, progress, what agents are doing, how long is left, or to open the board or dashboard.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })
    await takeUsage($)
    await reconcile($)
    $.clock.every(TICK_MS, () => {
      void tick($)
    })

    return result
  })

  on('command.run', { command: 'board' }, async $ => {
    await restore($)
    const opened = await openPane($)

    return { text: opened ? 'Workboard open.' : 'Workboard could not open here.' }
  })

  on('tool.call', { tool: TOOL_FULL }, async $ => {
    await restore($)
    const opened = await openPane($)
    const now = await $.clock.now()
    const head = opened
      ? 'The Workboard pane is open for the user.'
      : 'The pane did not open here (terminal too narrow for a pane opened by a tool); the user can type /board.'

    // A registered tool answers text (not an object): the board itself.
    return { result: `${head}\n\n${boardText(now)}` }
  })

  on('agent.spawn', async ($, e, next) => {
    await restore($)
    if (e.parentAgentId) {
      const result = await next(e)
      if (result.deny === undefined && result.agentId) {
        nested.set(result.agentId, topOf(e.parentAgentId))
      }

      return result
    }
    const now = await $.clock.now()
    if (!agents.some(a => a.status === 'running')) {
      batch = []
    }
    const description = e.name ? `${e.name}: ${e.description}` : e.description
    const agent: Agent = {
      ...newTrack(`${description}\n${e.prompt.slice(0, 1500)}`),
      id: '',
      key: e.tool_use_id,
      description,
      type: e.subagentType,
      model: shortModel(e.model ?? e.parentModel),
      status: 'running',
      startedAt: now,
      runStartedAt: now,
      activeMs: 0,
      runs: 1,
      tools: 0,
      last: '',
      lastAt: now,
    }
    agents = [...agents, agent].slice(-40)
    batch = [...batch, agent.key]
    main.hadAgents = true
    isDirty = true
    addLog(now, 'running', `started ${agent.description}`)
    $.ui.invalidate('ui.render')

    const result = await next(e)
    if (result.deny !== undefined) {
      finish(agent, 'failed', await $.clock.now())
    } else {
      agent.id = result.agentId ?? agent.id
      agent.model = shortModel(result.model)
    }
    $.ui.invalidate('ui.render')

    return result
  })

  on('tool.call', async ($, e, next) => {
    if (String(e.tool) === TOOL_FULL) {
      return next(e)
    }
    await restore($)
    isDirty = true
    const now = await $.clock.now()
    const args = e as unknown as Record<string, unknown>
    const activity = `${String(e.tool)} ${describe(args)}`.trim()

    let track: Track | undefined
    if (!e.agentId) {
      main.tools += 1
      main.last = activity
      main.lastAt = now
      track = mainTrack
    } else {
      const isNested = nested.has(e.agentId)
      const agent = agentFor(topOf(e.agentId))
      if (agent) {
        if (agent.status !== 'running' && !isNested) {
          resume(agent, now)
        }
        agent.tools += 1
        agent.last = activity
        agent.lastAt = now
        track = isNested ? undefined : agent
      } else {
        otherTools += 1
      }
    }

    const ran = await next(e)
    if (track && ran.deny === undefined && ran.isError === true) {
      noteOnLastStep(track, `${activity} failed`)
    }

    const command = typeof args.command === 'string' ? args.command : ''
    const isShell = e.tool === 'Bash' || String(e.tool) === 'PowerShell'
    if (!isShell || !TEST_COMMAND.test(command)) {
      return ran
    }

    const ended = await $.clock.now()
    const output = `${ran.text ?? ''}\n${safeJson(ran.result)}`.slice(-6000)
    const ok = ran.deny === undefined && ran.isError !== true && !looksFailed(output)
    const run: TestRun = { command: testInvocation(command), ok, at: ended, durationMs: ended - now, summary: testSummary(output) }
    tests = [run, ...tests].slice(0, 6)
    addLog(ended, ok ? 'done' : 'failed', `tests ${ok ? 'passed' : 'failed'}: ${run.command}`)
    $.ui.invalidate('ui.render')

    return ran
  })

  on('turn.step', async function* ($, e, next) {
    await restore($)
    const result = yield* next(e)
    const agent = e.agentId && !nested.has(e.agentId) ? agentFor(e.agentId) : undefined
    // A continued agent speaks before it calls a tool: that is its resume.
    if (agent && agent.status !== 'running') resume(agent, await $.clock.now())
    const track = !e.agentId ? mainTrack : agent
    if (track) {
      pushStep(track, stepLine(result.answer, result.toolUses))
      isDirty = true
    }

    return result
  })

  on('prompt.submit', async ($, e, next) => {
    await restore($)
    const result = await next(e)
    if (result.drop === undefined) {
      lastSubmit = { text: oneLine(e.text), isPerson: isPersonOrigin(e.origin) && !NOT_THE_PERSON.test(e.text) }
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    await restore($)
    const now = await $.clock.now()
    main.isWorking = true
    main.turnStartedAt = now
    main.tools = 0
    main.hadAgents = false
    // A continuation, a hand-back or a notice keeps the task it continues;
    // the origin prompt.submit saw decides, else the text's own look.
    const asked = oneLine(e.text)
    const submitted = lastSubmit && lastSubmit.text === asked ? lastSubmit.isPerson : undefined
    const isPerson = asked !== '' && (submitted ?? !NOT_THE_PERSON.test(e.text))
    if (isPerson && requests.at(-1) !== asked.slice(0, 300)) requests = [...requests, asked.slice(0, 300)].slice(-3)
    mainTrack = newTrack(isPerson ? `The person asked: ${asked.slice(0, 600)}` : mainTrack.task)
    isDirty = true
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await restore($)
    const result = await next(e)
    const now = await $.clock.now()
    isDirty = true

    if (!e.agentId) {
      main.isWorking = false
      main.lastTurnMs = e.durationMs
      changes += 1
      if (main.hadAgents) refreshSoon()
      $.ui.invalidate('ui.render')

      return result
    }

    const agent = nested.has(e.agentId) ? undefined : agentFor(e.agentId)
    if (agent && agent.status === 'running') {
      agent.result = firstSentence(e.answer)
      finish(agent, e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed', now)
      const p = progress(now)
      if (p.running === 0 && p.total > 0) {
        const failed = p.failed > 0 ? `, ${p.failed} failed` : ''
        $.ui.toast(`Workboard: all ${p.total} agents finished${failed} · ${duration(now - p.startedAt)}`)
        refreshSoon()
      }
    }
    $.ui.invalidate('ui.render')

    return result
  })

  on('session.measure', async ($, e, next) => {
    usage = {
      tokens: e.context.tokens,
      window: e.context.window,
      percent: e.context.percent,
      limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
      usd: e.cost?.usd,
    }
    $.ui.invalidate('ui.render')

    return next(e)
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      isPaneOpen = false
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await restore($)
    const now = await $.clock.now()
    const p = progress(now)
    if (e.props.hasSurvey || isPaneOpen || p.running === 0) {
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const parts = [`${p.running} running`]
    if (p.failed > 0) parts.push(`${p.failed} failed`)
    if (p.etaMs !== undefined) parts.push(eta(p.etaMs))
    parts.push(duration(now - p.startedAt))
    if (columns >= 90 && usage?.percent !== undefined) parts.push(`ctx ${Math.round(usage.percent)}%`)
    const lastTest = tests[0]
    if (columns >= 90 && lastTest && now - lastTest.at < 30 * 60_000) parts.push(`tests ${lastTest.ok ? '✓' : '✗'}`)

    return (
      <Box flexDirection="row" paddingX={1} gap={1}>
        <Text color="cyan">{bar(p.done + p.failed, p.total, columns >= 80 ? 10 : 6)}</Text>
        <Text bold>{`${p.done + p.failed}/${p.total} agents`}</Text>
        <Text dimColor wrap="truncate-end">{parts.join(' · ')}</Text>
        <Button key="open" label="board" hotkey="b" plain onPress={() => void openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code } = elements
    // Drawn means open, also for a pane still showing across a hot reload.
    isPaneOpen = true
    await restore($)
    const now = await $.clock.now()
    const columns = Math.max(32, e.props.bodyColumns)
    const width = columns - 2
    const shown = flow
    // The terminal draws cells, the desktop vectors, the rest plain ASCII.
    const Raster = e.surface === 'terminal' && 'Raster' in elements ? elements.Raster : undefined
    const Svg = e.surface === 'desktop' && 'Svg' in elements ? elements.Svg : undefined
    const grid = shown && Raster ? flowRaster(shown, width) : undefined
    const vector = shown && !grid && Svg ? flowSvg(shown, width) : undefined
    const ascii = shown && !grid && !vector ? flowText(shown, width) : undefined

    return (
      <Box flexDirection="column" width={columns} paddingX={1}>
        {shown && <Text bold>Flow</Text>}
        {grid && Raster && <Raster key="flow" columns={grid.columns} rows={grid.rows} cells={grid.cells} />}
        {vector && Svg && <Svg source={vector.source} alt={vector.alt} width={vector.width} height={vector.height} isInteractive />}
        {ascii && <Code source={ascii} wrap="truncate-end" />}
        {shown && <Text> </Text>}
        <Button key="refresh" label={refreshLabel(now)} hotkey="r" plain onPress={() => refreshSummaries($)} />
        <Text> </Text>
        <Text dimColor={!summary} wrap="wrap">{summaryText()}</Text>
        {summary && summary.next && <Text italic wrap="wrap">{summary.next}</Text>}
      </Box>
    )
  })
}

async function openPane($: EngineInterface): Promise<boolean> {
  const placed = await $.ui.open({ id: PANE, title: TITLE })
  isPaneOpen = isPaneOpen || placed.isPlaced

  return placed.isPlaced
}

// The ↻ button asks the next tick for a round that ignores the timers; a
// round already running is left to finish instead of being doubled.
function refreshSummaries($: EngineInterface) {
  if (summaries.isRunning) return
  summaries.isForced = true
  $.ui.invalidate('ui.render')
}

// A batch finished or a turn that ran agents ended: what the pane says is
// stale now, so the next tick reruns both (after the round in flight, if
// any); with the pane closed, the next open does.
function refreshSoon() {
  if (isPaneOpen) summaries.isForced = true
  else summaries.isStale = true
}

// One round, started from the tick while the pane is open: the flow first
// when it is due, so the summary Haiku writes next can read it. Each is due
// once its interval has passed and something changed since it last ran.
async function summarize($: EngineInterface) {
  if (summaries.isRunning || (!isPaneOpen && !summaries.isForced)) return
  summaries.isRunning = true
  const isForced = summaries.isForced || summaries.isStale
  summaries.isForced = false
  summaries.isStale = false
  try {
    const now = await $.clock.now()
    const isFlowDue = isForced || (now - summaries.flowAt >= FLOW_MS && changes !== summaries.flowChanges)
    const isSummaryDue = isForced || (now - summaries.summaryAt >= SUMMARY_MS && changes !== summaries.summaryChanges)
    if (hasBoard() && isFlowDue) await describeFlow($)
    if (hasBoard() && isSummaryDue) await writeSummary($)
  } finally {
    summaries.isRunning = false
    isDirty = true
    $.ui.invalidate('ui.render')
  }
}

// Sonnet: the whole job as steps and edges, from the conversation, the board
// and every piece of work in detail. The mod lays it out and draws it.
async function describeFlow($: EngineInterface) {
  const now = await $.clock.now()
  summaries.flowAt = now
  summaries.flowChanges = changes
  const conversation = await conversationText($, 14_000)
  const prompt = [
    'The conversation so far, oldest first:',
    conversation || '(not readable)',
    '',
    'The board right now:',
    boardText(now, true),
    '',
    'The work in detail:',
    workText(now),
    '',
    'Reply with the JSON object.',
  ].join('\n')

  let reply: ModelCompleteResult
  try {
    reply = await $.model.complete({ model: 'sonnet', system: FLOW_SYSTEM, prompt, effort: 'low', maxTokens: 2000, timeoutMs: 90_000 })
  } catch {
    summaries.failures += 1

    return
  }
  const described = answered(reply) && reply.isAnswered ? parseFlow(reply.text) : undefined
  if (described) {
    flow = described
    summaries.refreshedAt = await $.clock.now()
  } else if (reply.isAnswered) {
    summaries.failures += 1
  }
}

// Haiku: the summary of the whole chat at the bottom of the pane, from the
// same input plus the current flow, as long as the parallel work needs.
async function writeSummary($: EngineInterface) {
  const now = await $.clock.now()
  summaries.summaryAt = now
  summaries.summaryChanges = changes
  const budget = summaryBudget()
  const conversation = await conversationText($, 8000)
  const prompt = [
    'The conversation so far, oldest first:',
    conversation || '(not readable)',
    '',
    'The board right now:',
    boardText(now, true),
    '',
    'The work in detail:',
    workText(now),
    '',
    'The current flow, top to bottom:',
    flow ? flowText(flow, 72) : '(none yet)',
    '',
    `Budget: ${budget.running} subagent${budget.running === 1 ? '' : 's'} running, so at most ${budget.lines} line${budget.lines === 1 ? '' : 's'} and ${budget.words} words of summary${budget.running >= 5 ? ', grouping the agents by stream of work' : ''}, then the next line.`,
  ].join('\n')

  let reply: ModelCompleteResult
  try {
    reply = await $.model.complete({ model: 'haiku', system: SUMMARY_SYSTEM, prompt, effort: 'low', maxTokens: 400, timeoutMs: 60_000 })
  } catch {
    summaries.failures += 1

    return
  }
  const written = answered(reply) && reply.isAnswered ? summaryOf(reply.text, budget.words) : undefined
  if (written) {
    summary = written
    summaries.refreshedAt = await $.clock.now()
  } else if (reply.isAnswered) {
    summaries.failures += 1
  }
}

// How long the summary may run: one short line for one stream of work, a
// clause per stream for a few, grouped streams for many.
function summaryBudget(): { running: number; lines: number; words: number } {
  const running = agents.filter(a => a.status === 'running').length
  if (running <= 1) return { running, lines: 1, words: 30 }
  if (running <= 4) return { running, lines: 3, words: 70 }

  return { running, lines: 4, words: 90 }
}

// A call that did not answer counts as failed and leaves what it would have
// replaced as it was.
function answered(reply: ModelCompleteResult): boolean {
  if (!reply.isAnswered) summaries.failures += 1

  return reply.isAnswered
}

// The main conversation, newest kept first when it runs long: what the person
// asked in full, what Claude said and which tools it ran, without tool output,
// system reminders, hand-backs or notices.
async function conversationText($: EngineInterface, budget: number): Promise<string> {
  let messages
  try {
    messages = await $.session.messages()
  } catch {
    return ''
  }
  const rows: string[] = []
  let used = 0
  for (let i = messages.length - 1; i >= 0 && used < budget; i -= 1) {
    const m = messages[i]
    if (!m) continue
    const text = oneLine(m.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''))
    let row = ''
    if (m.role === 'user') {
      const isPerson = text !== '' && !(m.toolResults && m.toolResults.length > 0) && !NOT_THE_PERSON.test(text)
      if (isPerson) row = `person: ${cut(text, 1200)}`
    } else {
      const tools = m.toolUses.slice(0, 6).map(t => {
        const brief = describe(t.input).slice(0, 50)

        return brief ? `${t.tool} (${brief})` : t.tool
      })
      const said = text ? cut(text, 500) : ''
      if (said || tools.length > 0) row = `claude: ${said}${tools.length > 0 ? `${said ? ' ' : ''}[ran ${tools.join(', ')}]` : ''}`
    }
    if (row) {
      rows.push(row)
      used += row.length
    }
  }

  return rows.reverse().join('\n')
}

// Every top-level agent of the batch and the main turn: its task and its
// latest steps, the finished ones with their result.
function workText(now: number): string {
  const parts: string[] = []
  for (const a of orderedAgents().filter(a => a.status === 'running' || batch.includes(a.key)).slice(0, 12)) {
    parts.push(
      [
        `[${a.status}] ${a.description}, ${agentTime(a, now)}, ${a.tools} tools`,
        `Task: ${a.task}`,
        ...a.steps.map((step, i) => `${i + 1}. ${step}`),
        a.result ? `Result: ${a.result}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  if (main.isWorking || mainTrack.steps.length > 0) {
    parts.push(
      [`[${main.isWorking ? 'running' : 'idle'}] Main turn (the session the person talks to)`, `Task: ${mainTrack.task}`, ...mainTrack.steps.map((step, i) => `${i + 1}. ${step}`)].join('\n'),
    )
  }

  return parts.join('\n\n') || 'nothing yet'
}

function hasBoard(): boolean {
  return agents.length > 0 || tests.length > 0 || log.length > 0 || main.isWorking || main.lastTurnMs > 0
}

// Loads the records once per module load; every hook awaits the one load.
function restore($: EngineInterface): Promise<void> {
  restoring ??= load($)

  return restoring
}

async function load($: EngineInterface) {
  try {
    const kept = await $.state.get(AGENTS)
    if (kept.value) {
      agents = kept.value.map(a => ({ ...a, runStartedAt: a.runStartedAt ?? a.startedAt, activeMs: a.activeMs ?? 0, runs: a.runs ?? 1 }))
    }
    const order = await $.state.get(BATCH)
    if (order.value) batch = order.value
    const job = await $.state.get(JOB)
    if (job.value) {
      requests = job.value.requests
      mainTrack = newTrack(job.value.task)
    }
    const described = await $.state.get(FLOW)
    if (described.value) flow = described.value
    const written = await $.state.get(SUMMARY)
    if (written.value) summary = written.value
    const rounds = await $.state.get(ROUNDS)
    if (rounds.value) {
      const r = rounds.value
      summaries.flowAt = r.flowAt ?? -Infinity
      summaries.flowChanges = r.flowChanges
      summaries.summaryAt = r.summaryAt ?? -Infinity
      summaries.summaryChanges = r.summaryChanges
      summaries.refreshedAt = r.refreshedAt ?? -Infinity
      changes = Math.max(changes, r.changes)
    }
  } catch {
    // Nothing kept yet, or unreadable: start from the module's own copy.
  }
}

// Writes the records back (JSON only: a time never set is null).
async function save($: EngineInterface) {
  const time = (t: number) => (Number.isFinite(t) ? t : null)
  try {
    await $.state.set(AGENTS, agents)
    await $.state.set(BATCH, batch)
    await $.state.set(JOB, { requests, task: mainTrack.task })
    await $.state.set(FLOW, flow ?? null)
    await $.state.set(SUMMARY, summary ?? null)
    await $.state.set(ROUNDS, {
      flowAt: time(summaries.flowAt),
      flowChanges: summaries.flowChanges,
      summaryAt: time(summaries.summaryAt),
      summaryChanges: summaries.summaryChanges,
      changes,
      refreshedAt: time(summaries.refreshedAt),
    })
  } catch {
    isDirty = true
  }
}

async function takeUsage($: EngineInterface) {
  try {
    const u = await $.session.usage()
    usage = {
      tokens: u.context.tokens,
      window: u.context.window,
      percent: u.context.percent,
      limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
      usd: u.cost?.usd,
    }
  } catch {
    // No reading yet; session.measure fills it after the first response.
  }
}

// Every tick redraws the elapsed clocks while something runs and the ↻
// countdown while it shows, and every few ticks checks the engine's own list
// of agents, which also covers agents started before this module (re)loaded.
async function tick($: EngineInterface) {
  ticks += 1
  await restore($)
  if (ticks % 6 === 0) {
    await reconcile($)
  }
  if (isDirty) {
    isDirty = false
    await save($)
  }
  const now = await $.clock.now()
  const untilNext = nextRefreshAt() - now
  const isCounting = isPaneOpen && untilNext > 0 && untilNext < 60_000
  if (main.isWorking || agents.some(a => a.status === 'running') || isCounting) {
    $.ui.invalidate('ui.render')
  }
  void summarize($)
}

async function reconcile($: EngineInterface) {
  let listed
  try {
    listed = await $.agent.list()
  } catch {
    return
  }
  const now = await $.clock.now()
  for (const info of listed) {
    if (info.parentId) {
      if (!nested.has(info.id)) nested.set(info.id, topOf(info.parentId))
      continue
    }
    const known = agents.find(a => a.id === info.id)
    const status = statusOf(info.status)
    if (!known) {
      if (status === 'running') {
        if (!agents.some(a => a.status === 'running')) batch = []
        const description = info.name ? `${info.name}: ${info.description}` : info.description
        const agent: Agent = {
          ...newTrack(description),
          id: info.id,
          key: info.id,
          description,
          type: info.type,
          model: '',
          status: 'running',
          startedAt: now,
          runStartedAt: now,
          activeMs: 0,
          runs: 1,
          tools: 0,
          last: '',
          lastAt: now,
        }
        agents = [...agents, agent].slice(-40)
        batch = [...batch, agent.key]
        isDirty = true
      }
      continue
    }
    if (known.status === 'running' && status !== 'running' && status !== undefined) {
      finish(known, status, now)
      isDirty = true
    }
  }
}

function statusOf(raw: string): Status | undefined {
  const s = raw.toLowerCase()
  if (/run|pend|start|progress|active/.test(s)) return 'running'
  if (/fail|error/.test(s)) return 'failed'
  if (/kill|stop|abort|cancel/.test(s)) return 'stopped'
  if (/complet|done|finish|success/.test(s)) return 'done'

  return undefined
}

// The top-level agent a loop works for: itself, or the one that spawned it.
function topOf(agentId: string): string {
  return nested.get(agentId) ?? agentId
}

function agentFor(agentId: string): Agent | undefined {
  const known = agents.find(a => a.id === agentId)
  if (known) return known
  if (nested.has(agentId)) return undefined
  const pending = agents.filter(a => a.id === '' && a.status === 'running')
  const only = pending.length === 1 ? pending[0] : undefined
  if (only) {
    only.id = agentId

    return only
  }

  return undefined
}

function finish(agent: Agent, status: Status, now: number) {
  agent.status = status
  agent.endedAt = now
  agent.activeMs += Math.max(0, now - agent.runStartedAt)
  main.hadAgents = true
  const verb = status === 'done' ? 'finished' : status === 'stopped' ? 'stopped' : 'failed'
  addLog(now, status, `${verb} ${agent.description} · ${duration(now - agent.startedAt)}`)
}

function resume(agent: Agent, now: number) {
  if (!agents.some(a => a.status === 'running')) batch = []
  agent.status = 'running'
  agent.endedAt = undefined
  agent.runStartedAt = now
  agent.runs += 1
  if (!batch.includes(agent.key)) batch = [...batch, agent.key]
  addLog(now, 'running', `continued ${agent.description}`)
}

function progress(now: number): Progress {
  const inBatch = agents.filter(a => batch.includes(a.key))
  const done = inBatch.filter(a => a.status === 'done' || a.status === 'stopped').length
  const failed = inBatch.filter(a => a.status === 'failed').length
  const running = inBatch.filter(a => a.status === 'running')
  const startedAt = inBatch.reduce((min, a) => Math.min(min, a.startedAt), now)
  const finished = inBatch.filter(a => a.endedAt !== undefined)
  let etaMs: number | undefined
  if (finished.length > 0 && running.length > 0) {
    const mean = finished.reduce((sum, a) => sum + ((a.endedAt ?? now) - a.startedAt), 0) / finished.length
    etaMs = Math.max(0, ...running.map(a => mean - (now - a.startedAt)))
  }

  return { done, failed, running: running.length, total: inBatch.length, startedAt, etaMs }
}

function orderedAgents(): Agent[] {
  const rank = (a: Agent) => (a.status === 'running' ? 0 : batch.includes(a.key) ? 1 : 2)

  return [...agents].sort((x, y) => rank(x) - rank(y) || y.startedAt - x.startedAt)
}

function mainLine(now: number): string {
  if (main.isWorking) {
    const last = main.last ? ` · ${main.last}` : ''

    return `working ${duration(now - main.turnStartedAt)} · ${main.tools} tools${last}`
  }

  return main.lastTurnMs > 0 ? `idle · last turn ${duration(main.lastTurnMs)}` : 'idle'
}

function limitRows(now: number): { label: string; percent: number; detail: string }[] {
  if (!usage) return [{ label: 'ctx', percent: 0, detail: 'no reading yet' }]
  const rows: { label: string; percent: number; detail: string }[] = []
  const ctxPercent = usage.percent ?? (usage.tokens !== undefined ? (usage.tokens / usage.window) * 100 : 0)
  const tokens = usage.tokens !== undefined ? `${short(usage.tokens)} / ` : ''
  rows.push({ label: 'ctx', percent: ctxPercent, detail: `${Math.round(ctxPercent)}% · ${tokens}${short(usage.window)}` })
  for (const limit of usage.limits) {
    const label = limit.kind === 'five_hour' ? '5h' : limit.kind === 'seven_day' ? '7d' : limit.kind.replace(/_/g, ' ')
    const resets = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
    const when = Number.isFinite(resets) && resets > now ? ` · resets in ${duration(resets - now)}` : ''
    rows.push({ label, percent: limit.percentUsed, detail: `${Math.round(limit.percentUsed)}%${when}` })
  }
  if (usage.usd !== undefined) {
    rows.push({ label: 'cost', percent: 0, detail: `$${usage.usd.toFixed(2)} this session` })
  }

  return rows
}

// The board as plain text: what the open_board tool hands back to Claude, and
// for a prompt what the summarizers read: without the flow and the summary,
// which are written from it, and without usage.
function boardText(now: number, isForPrompt = false): string {
  const p = progress(now)
  const lines: string[] = []
  // The latest prompt alone is often a follow-up ("now fix the test"), so
  // the job is the last few requests together.
  if (requests.length > 0) {
    lines.push("Job (the person's latest requests, newest last):", ...requests.map(r => `- ${r}`))
  }
  lines.push(
    p.total === 0
      ? 'Agents: none spawned yet in this session.'
      : `Agents (current batch): ${p.done + p.failed}/${p.total} finished, ${p.running} running, ${p.failed} failed, batch ${duration(now - p.startedAt)}${p.etaMs !== undefined ? `, ${eta(p.etaMs)} (estimate from finished agents)` : ''}`,
  )
  for (const a of orderedAgents().slice(0, 15)) {
    const isRunning = a.status === 'running'
    const last = isRunning && a.last ? ` | last: ${a.last} (${ago(now - a.lastAt)})` : ''
    const result = !isRunning && a.result ? ` | result: ${a.result}` : ''
    lines.push(`- [${a.status}] ${a.description} | ${a.model || a.type} | ${agentTime(a, now)} | ${a.tools} tools${last}${result}`)
  }
  lines.push(`Main: ${mainLine(now)}`)
  if (tests.length > 0) {
    lines.push('Tests:')
    for (const t of tests.slice(0, 3)) {
      lines.push(`- ${t.ok ? 'PASS' : 'FAIL'} ${t.command}${t.summary ? ` (${t.summary})` : ''}, ${ago(now - t.at)}`)
    }
  }
  // Usage and limits are for Claude asking for status; the summarizers leave
  // them to the status line.
  if (!isForPrompt) {
    lines.push(`Limits: ${limitRows(now).map(r => `${r.label} ${r.detail}`).join('; ')}`)
  }
  if (log.length > 0) {
    lines.push('Recent:')
    for (const line of log.slice(0, 6)) {
      lines.push(`- ${ago(now - line.at)}: ${line.text}`)
    }
  }
  if (!isForPrompt && flow) {
    lines.push('Flow:', flowText(flow, 72))
  }
  if (!isForPrompt && summary) {
    lines.push('Summary:', summary.text)
    if (summary.next) lines.push(summary.next)
  }

  return lines.join('\n')
}

// When the next automatic round runs: the earlier of the two that something
// changed for; never (Infinity) when nothing did, or there is no board yet.
function nextRefreshAt(): number {
  if (!hasBoard()) return Infinity
  const flowAt = changes !== summaries.flowChanges ? summaries.flowAt + FLOW_MS : Infinity
  const summaryAt = changes !== summaries.summaryChanges ? summaries.summaryAt + SUMMARY_MS : Infinity

  return Math.min(flowAt, summaryAt)
}

// The footer: ↻ alone, ↻ … while a round runs, ↻ 42s in the last minute
// before an automatic one that would actually run.
function refreshLabel(now: number): string {
  if (summaries.isRunning || summaries.isForced) return '↻ …'
  const left = nextRefreshAt() - now

  return left > 0 && left < 60_000 ? `↻ ${Math.ceil(left / 1000)}s` : '↻'
}

// The summary paragraph as the pane draws it, whatever its state; wrapped in
// full, never cut, and the next clause goes under it on its own.
function summaryText(): string {
  if (!summary) return summaries.isRunning ? 'writing the summary…' : 'no summary yet: it comes once there is work on the board'

  return summary.text
}

// Elapsed from the first start; with continuations, the time spent running too.
function agentTime(a: Agent, now: number): string {
  const elapsed = duration((a.endedAt ?? now) - a.startedAt)
  if (a.runs <= 1) return elapsed
  const active = a.activeMs + (a.status === 'running' ? Math.max(0, now - a.runStartedAt) : 0)

  return `${elapsed} elapsed, ${duration(active)} active over ${a.runs} runs`
}

// The person typed it: at the terminal, through the bridge or the SDK, a Slack
// ping of their own, or a plugin submitting it as their words.
function isPersonOrigin(origin: PromptOrigin): boolean {
  const kind = origin.kind

  return kind === 'composer' || kind === 'bridge' || kind === 'sdk' || kind === 'slack-ping' || (kind === 'plugin' && origin.asUser === true)
}

// The test invocation alone: the shell segment that runs the tests, without
// the cd, env setup or pipes around it, cut to 60 characters.
function testInvocation(command: string): string {
  const segments = command.split(/&&|\|\||;|\||\r?\n/).map(part => oneLine(part).replace(/^(\w+=\S*\s+)+/, ''))
  const found = segments.find(part => TEST_COMMAND.test(part)) ?? oneLine(command)
  if (found.length <= 60) return found
  const head = found.slice(0, 59)
  const space = head.lastIndexOf(' ')

  return `${space > 40 ? head.slice(0, space) : head}…`
}

function newTrack(task: string): Track {
  return { task, steps: [] }
}

function pushStep(track: Track, line: string) {
  if (line === '') return
  track.steps = [...track.steps, line].slice(-STEPS_KEPT)
  changes += 1
}

// A failed tool call lands after the step that made it, so it is told there.
function noteOnLastStep(track: Track, note: string) {
  const last = track.steps[track.steps.length - 1]
  if (last === undefined) {
    pushStep(track, note)

    return
  }
  track.steps = [...track.steps.slice(0, -1), `${last} → ${note}`.slice(0, 600)]
  changes += 1
}

// One model step as the summarizer reads it: what it said, cut short, and the
// tools it called with a brief input each.
function stepLine(answer: string, toolUses: readonly { name: string; input: unknown }[]): string {
  const said = oneLine(answer)
  const parts: string[] = []
  if (said) parts.push(`said: ${cut(said, 400)}`)
  if (toolUses.length > 0) {
    const calls = toolUses.slice(0, 8).map(t => {
      const input = typeof t.input === 'object' && t.input !== null ? (t.input as Record<string, unknown>) : {}
      const brief = describe(input).slice(0, 60)

      return brief ? `${t.name} (${brief})` : t.name
    })
    parts.push(`called ${calls.join(', ')}`)
  }

  return parts.join('; ')
}

function firstSentence(text: string): string {
  const clean = oneLine(text.replace(/^[#>*\s-]+/, ''))
  const end = clean.search(/[.!?](\s|$)/)
  const sentence = end >= 0 ? clean.slice(0, end + 1) : clean

  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence
}

// Haiku's reply as one paragraph and, only when it ends with one, the next
// clause ('next: ...' or 'nothing needs you' after the start, a period, a
// semicolon, a dash or a line break), split here rather than trusting its line
// breaks. The paragraph keeps to the word cap by cutting at a sentence or
// clause boundary; nothing is ever cut mid-sentence with an ellipsis.
function summaryOf(text: string, words: number): Summary | undefined {
  const joined = text
    .split(/\r?\n/)
    .map(row => row.replace(/^\s*(summary\s*:|[-*•]|\d+[.)])\s*/i, '').trim())
    .filter(Boolean)
    .join('\n')
  let head = joined
  let next = ''
  const clause = /(^|[.;!?\n]|\s[—–-])\s*(next\s*:\s*|nothing (else )?needs you)/gi
  for (const found of joined.matchAll(clause)) {
    const at = (found.index ?? 0) + (found[1]?.length ?? 0)
    const rest = joined.slice(at).trim()
    const isNext = /^next\s*:/i.test(rest)
    if (!isNext && !/^nothing (else )?needs you[\s.!]*$/i.test(rest)) continue
    head = joined.slice(0, at)
    next = isNext ? `next: ${capWords(unquote(oneLine(rest.replace(/^next\s*:\s*/i, ''))), 24)}` : 'nothing needs you'
  }
  const body = capWords(unquote(oneLine(head)).replace(/[\s;,:—–-]+$/, ''), words)
  if (!body && !next) return undefined

  return { text: body, next }
}

// At most `words` words, cut at the last sentence end that fits, else the
// last clause boundary, and closed with a period; never an ellipsis.
function capWords(text: string, words: number): string {
  const all = text.split(' ').filter(Boolean)
  if (all.length <= words) return text
  const kept = all.slice(0, words).join(' ')
  const sentence = Math.max(kept.lastIndexOf('. '), kept.lastIndexOf('! '), kept.lastIndexOf('? '), /[.!?]$/.test(kept) ? kept.length - 1 : -1)
  if (sentence > kept.length / 3) return kept.slice(0, sentence + 1)
  const clause = Math.max(kept.lastIndexOf('; '), kept.lastIndexOf(', '), kept.lastIndexOf(' — '), kept.lastIndexOf(': '))
  const cutAt = clause > kept.length / 3 ? clause : kept.length

  return `${kept.slice(0, cutAt).replace(/[\s;,:—–-]+$/, '')}.`
}

function unquote(text: string): string {
  return text.replace(/^["'`*_]+|["'`*_]+$/g, '').trim()
}

function cut(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text
}

function describe(args: Record<string, unknown>): string {
  for (const field of ['description', 'command', 'file_path', 'pattern', 'query', 'url', 'subject', 'prompt']) {
    const value = args[field]
    if (typeof value === 'string' && value.trim() !== '') {
      const text = field === 'file_path' ? value.split(/[\\/]/).pop() ?? value : value

      return oneLine(text).slice(0, 80)
    }
  }

  return ''
}

function looksFailed(output: string): boolean {
  return /\b[1-9]\d*\s+(failed|failing|errors?)\b|\bFAILED\b|\bTests? failed\b/i.test(output)
}

function testSummary(output: string): string {
  const passed = output.match(/(\d+)\s+(passed|passing)/i)
  const failed = output.match(/(\d+)\s+(failed|failing)/i)
  const ran = output.match(/Ran\s+(\d+)\s+tests?/i)
  const parts: string[] = []
  if (passed) parts.push(`${passed[1]} passed`)
  if (failed && failed[1] !== '0') parts.push(`${failed[1]} failed`)
  if (parts.length === 0 && ran) parts.push(`${ran[1]} tests`)

  return parts.join(', ')
}

function addLog(at: number, status: Status, text: string) {
  log = [{ at, status, text }, ...log].slice(0, 12)
  changes += 1
}

function bar(value: number, total: number, width: number): string {
  const filled = total > 0 ? Math.min(width, Math.round((value / total) * width)) : 0

  return '▰'.repeat(filled) + '▱'.repeat(width - filled)
}

function eta(ms: number): string {
  return ms < 30_000 ? 'finishing any moment' : `~${duration(ms)} left`
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`

  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function ago(ms: number): string {
  return ms < 5000 ? 'now' : `${duration(ms)} ago`
}

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`

  return String(n)
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)(-\d{8})?$/, ' $1.$2')
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function safeJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value ?? '')
  } catch {
    return ''
  }
}
