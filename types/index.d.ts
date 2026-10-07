// The Workboard's contract: the records it keeps in $.state so a hot reload
// of its code does not lose them. Self-contained: no import or reference.

export type WorkboardStatus = 'running' | 'done' | 'failed' | 'stopped'

// One top-level subagent: what it was asked, its last steps, and its time and
// tool count over every run (a continued agent keeps its first start).
export type WorkboardAgent = {
  id: string
  key: string
  description: string
  type: string
  model: string
  status: WorkboardStatus
  task: string
  steps: string[]
  startedAt: number
  runStartedAt: number
  activeMs: number
  runs: number
  endedAt?: number
  tools: number
  last: string
  lastAt: number
  result?: string
}

// The person's own latest requests, and the task the main turn works on.
export type WorkboardJob = { requests: string[]; task: string }

export type WorkboardFlowState = 'done' | 'running' | 'failed' | 'waiting' | 'check'

export type WorkboardFlowStep = { id: string; label: string; state: WorkboardFlowState; progress?: number; detail?: string }

export type WorkboardFlowEdge = { from: string; to: string; label?: string }

// Sonnet's description of the whole job, which the pane lays out and draws.
export type WorkboardFlow = { steps: WorkboardFlowStep[]; edges: WorkboardFlowEdge[] }

// Haiku's summary: one paragraph, and the next clause when it ended with one.
export type WorkboardSummary = { text: string; next: string }

// When each summarizer last ran and at which change count (null: never), the
// change count itself, and when either last answered.
export type WorkboardRounds = {
  flowAt: number | null
  flowChanges: number
  summaryAt: number | null
  summaryChanges: number
  changes: number
  refreshedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    workboard: {
      agents: WorkboardAgent[]
      batch: string[]
      job: WorkboardJob
      flow: WorkboardFlow | null
      summary: WorkboardSummary | null
      rounds: WorkboardRounds
    }
  }
}
