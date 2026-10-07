// The flow diagram: Sonnet describes the job as steps and edges, and this file
// lays them out the same way every time and draws them three ways: Raster
// cells for the terminal, an Svg for the desktop, plain ASCII elsewhere and in
// the board text. No $ here: everything is a pure function of the flow.
//
// Layout, compact: layers top to bottom by longest path, an edge that skips a
// layer routed through a dummy slot, each layer ordered by its parents'
// positions to keep crossings down. A plain chain (one step feeding the next,
// nothing else in or out) shares a row, left to right. Cards are one row tall
// and as wide as their label; a connector is one row, two where it bends.

import type { WorkboardFlow, WorkboardFlowEdge, WorkboardFlowState, WorkboardFlowStep } from '../types'

export type FlowState = WorkboardFlowState

export type FlowStep = WorkboardFlowStep

export type FlowEdge = WorkboardFlowEdge

export type Flow = WorkboardFlow

export type RasterGrid = { columns: number; rows: number; cells: string }

export type SvgDrawing = { source: string; alt: string; width: number; height: number }

export const MAX_STEPS = 8
const MAX_EDGES = 10
const LABEL_CHARS = 24
const DETAIL_CHARS = 200
const EDGE_LABEL_CHARS = 8
const CARD_MAX = 28
const GAP = 2
const CHAIN_GAP = 3
const MAX_WIDTH = 60
const MAX_ROWS = 256
const DEFAULT = 0x01000000
const STATES: readonly FlowState[] = ['done', 'running', 'failed', 'waiting', 'check']

// One fill and one text colour per state, differing in lightness as well as
// hue, and a glyph per state so colour never carries the meaning alone. A
// running step's progress fills its card from the left; the rest is `rest`.
export const STATE_STYLE: Record<FlowState, { fill: number; text: number; glyph: string; tag: string; rest?: number }> = {
  done: { fill: 0x2e7d32, text: 0xffffff, glyph: '✓', tag: 'done' },
  running: { fill: 0x26c6da, text: 0x0b1f24, glyph: '●', tag: 'run', rest: 0xb2ebf2 },
  failed: { fill: 0xc62828, text: 0xffffff, glyph: '✗', tag: 'FAIL' },
  waiting: { fill: 0x546e7a, text: 0xffffff, glyph: '○', tag: 'wait' },
  check: { fill: 0xffb300, text: 0x1a1a1a, glyph: '◆', tag: 'check' },
}
const CONNECTOR = 0x8a8f98
const EDGE_TEXT = 0xb0b6be

// --- reading Sonnet's reply -------------------------------------------------

// The reply's first balanced {...} as a flow: unknown states become waiting,
// edges to unknown steps, self edges and edges that close a loop are dropped,
// and every string is cut to what a card holds.
export function parseFlow(text: string): Flow | undefined {
  const raw = firstObject(text)
  if (raw === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) return undefined

  const steps: FlowStep[] = []
  for (const item of parsed.steps) {
    if (!isRecord(item) || steps.length >= MAX_STEPS) continue
    const id = typeof item.id === 'string' || typeof item.id === 'number' ? String(item.id) : ''
    const label = typeof item.label === 'string' ? cutText(oneLine(item.label), LABEL_CHARS) : ''
    if (!id || !label || steps.some(s => s.id === id)) continue
    const state = STATES.find(s => s === item.state) ?? 'waiting'
    const step: FlowStep = { id, label, state }
    if (state === 'running' && typeof item.progress === 'number' && Number.isFinite(item.progress)) {
      step.progress = Math.max(0, Math.min(1, item.progress > 1 ? item.progress / 100 : item.progress))
    }
    if (typeof item.detail === 'string' && item.detail.trim() !== '') step.detail = cutText(oneLine(item.detail), DETAIL_CHARS)
    steps.push(step)
  }
  if (steps.length === 0) return undefined

  const edges: FlowEdge[] = []
  for (const item of Array.isArray(parsed.edges) ? parsed.edges : []) {
    if (!isRecord(item) || edges.length >= MAX_EDGES) continue
    const from = String(item.from ?? '')
    const to = String(item.to ?? '')
    if (from === to || !steps.some(s => s.id === from) || !steps.some(s => s.id === to)) continue
    if (edges.some(e => e.from === from && e.to === to) || reaches(edges, to, from)) continue
    const edge: FlowEdge = { from, to }
    if (typeof item.label === 'string' && item.label.trim() !== '') edge.label = cutText(oneLine(item.label), EDGE_LABEL_CHARS)
    edges.push(edge)
  }

  return { steps, edges }
}

function reaches(edges: readonly FlowEdge[], from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length > 0) {
    const at = stack.pop() as string
    if (at === to) return true
    if (seen.has(at)) continue
    seen.add(at)
    for (const e of edges) if (e.from === at) stack.push(e.to)
  }

  return false
}

// --- layout -------------------------------------------------------------------

type Mode = 'cells' | 'ascii'

type Item = { key: string; step?: FlowStep; width: number; x: number; center: number }

type Row = { y: number; items: Item[]; isChain: boolean; gap: number }

type Link = { from: string; to: string; label?: string }

type Layout = { columns: number; rows: number; lines: Row[]; links: Link[] }

// What a card shows: the glyph and label in the terminal and on the desktop;
// in ASCII the state rides the shape (a check is <...>) and a tag.
function cardText(step: FlowStep, mode: Mode): string {
  const style = STATE_STYLE[step.state]
  if (mode === 'cells') return ` ${style.glyph} ${cutText(step.label, CARD_MAX - 4)} `
  if (step.state === 'check') return `< ${step.label} >`
  const tag = step.state === 'running' && step.progress !== undefined ? `${style.tag} ${Math.round(step.progress * 100)}%` : style.tag

  return `[ ${step.label} (${tag}) ]`
}

function layoutFlow(flow: Flow, columns: number, mode: Mode): Layout {
  const order = new Map(flow.steps.map((s, i) => [s.id, i]))
  const linked = new Set(flow.edges.flatMap(e => [e.from, e.to]))

  // Longest path from the roots, in the steps' own order; steps no edge
  // touches each get a layer of their own below, in order.
  const layer = new Map<string, number>()
  for (const s of flow.steps) if (linked.has(s.id)) layer.set(s.id, 0)
  for (let pass = 0; pass < flow.steps.length; pass += 1) {
    for (const e of flow.edges) {
      const next = (layer.get(e.from) ?? 0) + 1
      if (next > (layer.get(e.to) ?? 0)) layer.set(e.to, next)
    }
  }
  let bottom = Math.max(-1, ...layer.values())
  for (const s of flow.steps) if (!linked.has(s.id)) layer.set(s.id, (bottom += 1))

  // Slots per layer, with a dummy slot wherever an edge passes a layer by.
  const layers: { step?: FlowStep; key: string }[][] = Array.from({ length: bottom + 1 }, () => [])
  for (const s of flow.steps) layers[layer.get(s.id) ?? 0]?.push({ step: s, key: s.id })
  const links: Link[] = []
  for (const e of flow.edges) {
    const top = layer.get(e.from) ?? 0
    const end = layer.get(e.to) ?? 0
    let previous = e.from
    for (let l = top + 1; l < end; l += 1) {
      const key = `${e.from}>${e.to}@${l}`
      layers[l]?.push({ key })
      links.push({ from: previous, to: key })
      previous = key
    }
    links.push({ from: previous, to: e.to, label: e.label })
  }

  // Order each layer by where its parents sit (two sweeps), steps in their
  // own order when nothing above decides.
  const position = new Map<string, number>()
  layers.forEach(row => row.forEach((slot, i) => position.set(slot.key, i)))
  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (const row of layers.slice(1)) {
      const weight = (key: string) => {
        const parents = links.filter(s => s.to === key).map(s => position.get(s.from) ?? 0)

        return parents.length > 0 ? parents.reduce((a, b) => a + b, 0) / parents.length : order.get(key) ?? 0
      }
      row.sort((a, b) => weight(a.key) - weight(b.key))
      row.forEach((slot, i) => position.set(slot.key, i))
    }
  }

  const width = Math.max(1, Math.min(mode === 'ascii' ? 72 : MAX_WIDTH, columns))
  const widthOf = (slot: { step?: FlowStep }) => (slot.step ? Math.min(mode === 'ascii' ? 34 : CARD_MAX, cardText(slot.step, mode).length) : 1)

  // Rows: a layer, or a plain chain of one-step layers packed left to right
  // while it fits (an unlabelled edge, nothing else into or out of either).
  const groups: { slots: { step?: FlowStep; key: string }[]; isChain: boolean }[] = []
  for (const row of layers) {
    const last = groups.at(-1)
    const tail = last?.slots.at(-1)
    const only = row.length === 1 ? row[0] : undefined
    const out = tail ? links.filter(k => k.from === tail.key) : []
    const into = only ? links.filter(k => k.to === only.key) : []
    const isPlainChain =
      last !== undefined &&
      (last.isChain || last.slots.length === 1) &&
      tail?.step !== undefined &&
      only?.step !== undefined &&
      out.length === 1 &&
      into.length === 1 &&
      out[0] === into[0] &&
      out[0]?.label === undefined
    const used = last ? last.slots.reduce((sum, s) => sum + widthOf(s), 0) + (last.slots.length - 1) * CHAIN_GAP : 0
    if (isPlainChain && only && last && used + CHAIN_GAP + widthOf(only) <= width) {
      last.slots.push(only)
      last.isChain = true
    } else {
      groups.push({ slots: [...row], isChain: false })
    }
  }

  // Positions: each item under its parents where it can be, packed left to
  // right without overlap, inside the width.
  const centers = new Map<string, number>()
  const lines: Row[] = []
  for (const group of groups) {
    const gap = group.isChain ? CHAIN_GAP : GAP
    const widths = group.slots.map(widthOf)
    const total = widths.reduce((a, b) => a + b, 0) + gap * (widths.length - 1)
    const lefts: number[] = []
    let start = Math.floor((width - total) / 2)
    widths.forEach(w => {
      lefts.push(start)
      start += w + gap
    })
    const wanted = group.slots.map((slot, i) => {
      const parents = links.filter(k => k.to === slot.key).map(k => centers.get(k.from)).filter((c): c is number => c !== undefined)
      const w = widths[i] ?? 1

      return parents.length > 0 ? Math.round(parents.reduce((a, b) => a + b, 0) / parents.length) - Math.floor(w / 2) : undefined
    })
    if (group.isChain) {
      const shift = wanted[0] !== undefined ? wanted[0] - (lefts[0] ?? 0) : 0
      for (let i = 0; i < lefts.length; i += 1) lefts[i] = (lefts[i] ?? 0) + shift
    } else {
      let right = -GAP
      for (let i = 0; i < lefts.length; i += 1) {
        const x = Math.max(wanted[i] ?? lefts[i] ?? 0, right + GAP)
        lefts[i] = x
        right = x + (widths[i] ?? 1)
      }
      // Packing pushes siblings right of their parent; shift the row back so
      // it sits centred under the parents it hangs from.
      const off = wanted.map((w, i) => (w === undefined ? undefined : w - (lefts[i] ?? 0))).filter((d): d is number => d !== undefined)
      const shift = off.length > 0 ? Math.round(off.reduce((a, b) => a + b, 0) / off.length) : 0
      const room = Math.max(0, width - right)
      const moved = Math.max(-(lefts[0] ?? 0), Math.min(room, shift))
      for (let i = 0; i < lefts.length; i += 1) lefts[i] = (lefts[i] ?? 0) + moved
    }
    const overflow = (lefts.at(-1) ?? 0) + (widths.at(-1) ?? 1) - width
    const back = Math.min(lefts[0] ?? 0, Math.max(0, overflow))
    const items = group.slots.map((slot, i) => {
      const x = Math.max(0, (lefts[i] ?? 0) - back)
      const w = widths[i] ?? 1

      return { ...slot, width: w, x, center: x + (slot.step ? Math.floor(w / 2) : 0) }
    })
    for (const item of items) centers.set(item.key, item.center)
    lines.push({ y: 0, items, isChain: group.isChain, gap: 0 })
  }

  // Rows between: one where every connector runs straight down, two where
  // one bends; the y of each row follows.
  const rowOf = new Map<string, number>()
  lines.forEach((line, r) => line.items.forEach(item => rowOf.set(item.key, r)))
  let y = 0
  lines.forEach((line, r) => {
    line.y = y
    const down = links.filter(k => rowOf.get(k.from) === r && rowOf.get(k.to) === r + 1)
    line.gap = r === lines.length - 1 ? 0 : down.every(k => centers.get(k.from) === centers.get(k.to)) ? 1 : 2
    y += 1 + line.gap
  })

  return { columns: width, rows: Math.min(MAX_ROWS, Math.max(1, y)), lines, links }
}

// --- a grid of cells, shared by the Raster and the ASCII drawing ------------

type Cell = { char: string; fg: number; bg: number }

const UP = 1
const DOWN = 2
const LEFT = 4
const RIGHT = 8

function connectorChar(bits: number, isAscii: boolean): string {
  if (isAscii) {
    if (bits === UP || bits === DOWN || bits === (UP | DOWN)) return '|'
    if (bits === LEFT || bits === RIGHT || bits === (LEFT | RIGHT)) return '-'

    return '+'
  }
  const table: Record<number, string> = {
    [UP]: '│', [DOWN]: '│', [UP | DOWN]: '│', [LEFT]: '─', [RIGHT]: '─', [LEFT | RIGHT]: '─',
    [DOWN | RIGHT]: '┌', [DOWN | LEFT]: '┐', [UP | RIGHT]: '└', [UP | LEFT]: '┘',
    [UP | DOWN | RIGHT]: '├', [UP | DOWN | LEFT]: '┤', [DOWN | LEFT | RIGHT]: '┬', [UP | LEFT | RIGHT]: '┴',
    [UP | DOWN | LEFT | RIGHT]: '┼',
  }

  return table[bits] ?? '┼'
}

function drawGrid(flow: Flow, columns: number, mode: Mode): Cell[][] {
  const isAscii = mode === 'ascii'
  const layout = layoutFlow(flow, columns, mode)
  const grid: Cell[][] = Array.from({ length: layout.rows }, () =>
    Array.from({ length: layout.columns }, () => ({ char: ' ', fg: DEFAULT, bg: DEFAULT })),
  )
  const line = isAscii ? DEFAULT : CONNECTOR
  const put = (row: number, col: number, char: string, fg = DEFAULT, bg = DEFAULT) => {
    const cell = grid[row]?.[col]
    if (cell) Object.assign(cell, { char, fg, bg })
  }
  const bits = new Map<string, number>()
  const addBits = (row: number, col: number, b: number) => bits.set(`${row},${col}`, (bits.get(`${row},${col}`) ?? 0) | b)
  const marks: [number, number, string, number][] = []
  const where = new Map<string, { row: Row; item: Item }>()
  for (const row of layout.lines) for (const item of row.items) where.set(item.key, { row, item })

  // Down: straight into the card below (one row), or across and down (two).
  for (const link of layout.links) {
    const a = where.get(link.from)
    const b = where.get(link.to)
    if (!a || !b || a.row === b.row) continue
    const first = a.row.y + 1
    const tip = a.row.gap === 1 ? first : first + 1
    if (a.row.gap === 2) {
      if (a.item.center === b.item.center) {
        addBits(first, a.item.center, UP | DOWN)
      } else {
        const toRight = b.item.center > a.item.center
        addBits(first, a.item.center, UP | (toRight ? RIGHT : LEFT))
        addBits(first, b.item.center, DOWN | (toRight ? LEFT : RIGHT))
        for (let c = Math.min(a.item.center, b.item.center) + 1; c < Math.max(a.item.center, b.item.center); c += 1) addBits(first, c, LEFT | RIGHT)
      }
    }
    if (b.item.step) {
      marks.push([tip, b.item.center, isAscii ? 'v' : '▼', line])
      if (link.label) {
        for (let i = 0; i < link.label.length; i += 1) marks.push([tip, b.item.center + 2 + i, link.label[i] ?? ' ', isAscii ? DEFAULT : EDGE_TEXT])
      }
    } else {
      addBits(tip, b.item.center, UP | DOWN)
    }
  }
  for (const row of layout.lines) for (const item of row.items) if (!item.step) addBits(row.y, item.center, UP | DOWN)
  for (const [key, b] of bits) {
    const [row, col] = key.split(',').map(Number) as [number, number]
    put(row, col, connectorChar(b, isAscii), line)
  }
  for (const [row, col, char, fg] of marks) put(row, col, char, fg)

  // Cards, one row each, and the arrow between the cards of a chain.
  for (const row of layout.lines) {
    row.items.forEach((item, i) => {
      if (!item.step) return
      const text = cutText(cardText(item.step, mode), item.width)
      if (isAscii) {
        for (let c = 0; c < item.width; c += 1) put(row.y, item.x + c, text[c] ?? ' ')
      } else {
        const style = STATE_STYLE[item.step.state]
        const filled = item.step.progress !== undefined ? Math.round(item.step.progress * item.width) : item.width
        for (let c = 0; c < item.width; c += 1) {
          put(row.y, item.x + c, text[c] ?? ' ', style.text, c < filled ? style.fill : style.rest ?? style.fill)
        }
      }
      const next = row.items[i + 1]
      if (row.isChain && next) put(row.y, item.x + item.width + 1, isAscii ? '>' : '▶', line)
    })
  }

  return grid
}

// The terminal's drawing: the grid as base64 little-endian u32 triplets.
export function flowRaster(flow: Flow, columns: number): RasterGrid {
  const grid = drawGrid(flow, columns, 'cells')
  const rows = grid.length
  const width = grid[0]?.length ?? 1
  const words = new Uint32Array(width * rows * 3)
  let i = 0
  for (const row of grid) {
    for (const cell of row) {
      words[i] = cell.char.codePointAt(0) ?? 0x20
      words[i + 1] = cell.fg
      words[i + 2] = cell.bg
      i += 3
    }
  }

  return { columns: width, rows, cells: base64(new Uint8Array(words.buffer)) }
}

// Plain ASCII, for surfaces without a drawing element and for the board text.
export function flowText(flow: Flow, columns: number): string {
  return drawGrid(flow, columns, 'ascii')
    .map(row => row.map(c => c.char).join('').trimEnd())
    .join('\n')
}

// The desktop's drawing: the same layout in pixels (6 per column), small
// rounded cards, tight gaps, arrows, each step's detail as a tooltip.
export function flowSvg(flow: Flow, columns: number): SvgDrawing {
  const layout = layoutFlow(flow, columns, 'cells')
  const cw = 6
  const cardH = 18
  const gapH = 10
  const top = (row: Row) => layout.lines.slice(0, layout.lines.indexOf(row)).reduce((sum, r) => sum + cardH + r.gap * gapH, 0)
  const width = layout.columns * cw
  const height = layout.lines.reduce((sum, r) => sum + cardH + r.gap * gapH, 0)
  const where = new Map<string, { row: Row; item: Item }>()
  for (const row of layout.lines) for (const item of row.items) where.set(item.key, { row, item })
  const mid = (item: Item) => item.center * cw + cw / 2

  const parts: string[] = []
  for (const link of layout.links) {
    const a = where.get(link.from)
    const b = where.get(link.to)
    if (!a || !b || a.row === b.row) continue
    const start = top(a.row) + (a.item.step ? cardH - 2 : cardH)
    const end = top(b.row) + (b.item.step ? 0 : 0)
    const bend = top(a.row) + cardH + gapH / 2
    const path = a.item.center === b.item.center ? `M${mid(a.item)},${start} V${end}` : `M${mid(a.item)},${start} V${bend} H${mid(b.item)} V${end}`
    parts.push(`<path d="${path}" fill="none" stroke="#8a8f98" stroke-width="1"${b.item.step ? ' marker-end="url(#arrow)"' : ''}/>`)
    if (link.label && b.item.step) parts.push(`<text x="${mid(b.item) + 5}" y="${end - 2}" font-size="9" fill="#8a8f98">${escapeXml(link.label)}</text>`)
  }
  for (const row of layout.lines) {
    const y = top(row)
    row.items.forEach((item, i) => {
      if (!item.step) {
        parts.push(`<line x1="${mid(item)}" y1="${y}" x2="${mid(item)}" y2="${y + cardH}" stroke="#8a8f98" stroke-width="1"/>`)
        return
      }
      const style = STATE_STYLE[item.step.state]
      const x = item.x * cw
      const w = item.width * cw
      const tip = `${item.step.label}${item.step.detail ? `: ${item.step.detail}` : ''} (${item.step.state}${item.step.progress !== undefined ? `, ${Math.round(item.step.progress * 100)}%` : ''})`
      const fill =
        item.step.progress !== undefined
          ? `<rect x="${x}" y="${y + 1}" width="${w}" height="${cardH - 3}" rx="4" fill="#${hex(style.rest ?? style.fill)}"/><rect x="${x}" y="${y + 1}" width="${Math.round(w * item.step.progress)}" height="${cardH - 3}" rx="4" fill="#${hex(style.fill)}"/>`
          : `<rect x="${x}" y="${y + 1}" width="${w}" height="${cardH - 3}" rx="4" fill="#${hex(style.fill)}"/>`
      parts.push(
        `<g><title>${escapeXml(tip)}</title>${fill}<rect x="${x}" y="${y + 1}" width="${w}" height="${cardH - 3}" rx="4" fill="none" stroke="#8a8f98" stroke-width="1"/><text x="${x + w / 2}" y="${y + cardH / 2 + 3}" text-anchor="middle" font-size="10" fill="#${hex(style.text)}">${escapeXml(cardText(item.step, 'cells').trim())}</text></g>`,
      )
      const next = row.items[i + 1]
      if (row.isChain && next) {
        parts.push(`<path d="M${x + w + 2},${y + cardH / 2} H${next.x * cw - 3}" stroke="#8a8f98" stroke-width="1" marker-end="url(#arrow)"/>`)
      }
    })
  }
  const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="ui-sans-serif, system-ui, sans-serif"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#8a8f98"/></marker></defs>${parts.join('')}</svg>`
  const alt = `Flow of the job, top to bottom: ${flow.steps.map(s => `${s.label} (${s.state})`).join(', ')}`

  return { source, alt, width, height }
}

// --- small helpers ------------------------------------------------------------

function cutText(text: string, length: number): string {
  if (length <= 0) return ''

  return text.length > length ? `${text.slice(0, Math.max(0, length - 1))}…` : text
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hex(color: number): string {
  return color.toString(16).padStart(6, '0')
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += ALPHABET[(n >> 18) & 63]
    out += ALPHABET[(n >> 12) & 63]
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? ALPHABET[n & 63] : '='
  }

  return out
}

// The first balanced {...} in a reply; whatever surrounds it is ignored.
export function firstObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let isInString = false
  let isEscaped = false
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]
    if (isInString) {
      if (isEscaped) isEscaped = false
      else if (c === '\\') isEscaped = true
      else if (c === '"') isInString = false
    } else if (c === '"') {
      isInString = true
    } else if (c === '{') {
      depth += 1
    } else if (c === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return undefined
}
