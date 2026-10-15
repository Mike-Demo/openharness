/**
 * A keyframe's history re-wrapped by word for the pane's width, for an engine that keeps its conversation in the
 * terminal's scrollback (facets/launch.ts `ScreenContract`).
 *
 * Why: one pane is driven by a desktop window and a phone in turn, and each takeover resizes it to the new
 * controller's grid. tmux re-wraps what is already in its history by the cell, so a reply the engine laid out for
 * 160 columns reached a 40-column phone with its words cut in two at the edge ("… I read a" / "nd edit files …"),
 * every continuation in column 0 (a phone, 2026-10-08). The engine itself wraps by word under a hanging indent; this does the same for
 * the rows it can no longer reach. Column 0 matters beyond looks: the phone's long-press reads a message as ending
 * at the next row with anything there (mobile/lib/terminal/output_blocks.dart).
 *
 * Only the history: the visible grid is still the engine's to address, so it is sent exactly as tmux holds it.
 * The input is `capture-pane -J -e`, whose lines are the logical lines tmux joined back up. Rows are measured as
 * the viewers' xterm.dart moves its cursor (cellAdvance.ts) and are written in the shape normalizeTmuxHistoryLines
 * (tmuxStream.ts) writes, each restoring the style tmux carried into it (sgrCarry.ts).
 */
import { cellAdvance } from './cellAdvance.js'
import { SgrCarry } from './sgrCarry.js'

/** The narrowest pane re-wrapped: below it a hanging indent leaves too little room, and tmux's cut is kept. */
export const REWRAP_MIN_WIDTH = 20

/** The widest hanging indent, as a share of the width: at the narrowest pane it still leaves 12 columns for text. */
const MAX_HANG_SHARE = 0.4

type Unit =
  | { escape: string }
  /** `joins`: kept with the code point before it (a mark, a joiner or what follows one, a selector, a modifier). */
  | { text: string; width: number; space: boolean; joins: boolean }

/** CSI, OSC (BEL or ST ended, or cut off at the line's end), or any other two-byte escape. */
const ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[\s\S])?/y
const MARK = /\p{M}/u
/** A rule: only rule strokes and spaces (Claude Code draws one above and below its prompt). */
const RULE = /^[ ─━═╌╍┄┅-]*[─━═╌╍┄┅-]{3}[ ─━═╌╍┄┅-]*$/
/** Box drawing, which lays out tables and frames cell by cell. */
const BOX = /[\u2500-\u257f]/g
/**
 * What a continuation is indented past: a message's mark (Claude Code's `⏺`/`●`, Codex's `•`), a list's bullet
 * or number, a result's tree mark (`⎿`, `└`), a prompt (`›`, `❯`), each with the spaces after it, or a diff's
 * line number and sign, with any after it — the indents both engines give their own wrapped lines. A diff's text
 * may start right at its sign (`22 +- Winning`, `5 +<meta`).
 */
const MARKER = /^(?:(?:[⏺●•◦▪‣*+›❯⎿└├│-]|\d{1,3}[.)]) +|\d{1,6} [+\- ] *)/u
/** A diff line's gutter: its line number and sign (Codex's `    22 +`, Claude Code's `      12 -`). */
const GUTTER = /^\s*\d{1,6} [+\- ]/
const SPACE: Unit = { text: ' ', width: 1, space: true, joins: false }

function joins(codePoint: number, afterJoiner: boolean): boolean {
  return afterJoiner
    || codePoint === 0x200d
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    || (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff)
    || (codePoint >= 0xe0020 && codePoint <= 0xe007f)
    || MARK.test(String.fromCodePoint(codePoint))
}

/** One captured line as escapes and measured code points. Tabs become spaces; other controls are left out. */
function unitsOf(line: string): Unit[] {
  const units: Unit[] = []
  let column = 0
  let afterJoiner = false
  for (let index = 0; index < line.length;) {
    if (line.charCodeAt(index) === 0x1b) {
      ESCAPE.lastIndex = index
      const escape = ESCAPE.exec(line)![0]
      units.push({ escape })
      index += escape.length
      continue
    }
    const codePoint = line.codePointAt(index)!
    const text = String.fromCodePoint(codePoint)
    index += text.length
    if (codePoint === 0x09) {
      for (let pad = 8 - (column % 8); pad > 0; pad--, column++) units.push({ text: ' ', width: 1, space: true, joins: false })
      afterJoiner = false
      continue
    }
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) continue
    const width = cellAdvance(codePoint)
    units.push({ text, width, space: codePoint === 0x20, joins: joins(codePoint, afterJoiner) })
    afterJoiner = codePoint === 0x200d
    column += width
  }
  return units
}

const visibleText = (units: readonly Unit[]): string => units.map((unit) => 'text' in unit ? unit.text : '').join('')
const widthOf = (units: readonly Unit[]): number => units.reduce((sum, unit) => sum + ('width' in unit ? unit.width : 0), 0)
const columnsOf = (text: string): number => [...text].reduce((sum, char) => sum + cellAdvance(char.codePointAt(0)!), 0)

/** A line laid out cell by cell, which a word wrap would scramble: a table's row, a frame. */
function isRigid(text: string): boolean {
  return (text.match(BOX)?.length ?? 0) >= 3 || (text.match(/\|/g)?.length ?? 0) >= 3
}

/** The rows written so far, and the one being written. Each row ends reset and starts with the style carried in. */
class Rows {
  readonly out: string[] = []
  private readonly carry = new SgrCarry()
  /** The OSC 8 that opened the link still open, re-opened on each row it continues onto. */
  private link: string | null = null
  private row = ''
  column = 0

  constructor(readonly width: number) {}

  /** `colouredIndent`: the indent takes the style carried in, for a block coloured from its first column. */
  start(indent = 0, colouredIndent = false): void {
    const restore = this.carry.restore
    const pad = ' '.repeat(indent)
    this.row = (colouredIndent ? restore + pad : pad + restore) + (this.link ?? '')
    this.column = indent
  }

  /** Whether the style in force paints behind the text. */
  get filled(): boolean {
    return this.carry.filled
  }

  escape(text: string): void {
    this.row += text
    if (text.startsWith('\u001b[') && text.endsWith('m')) this.carry.feed(text)
    else if (text.startsWith('\u001b]8;')) this.link = /^\u001b\]8;[^;]*;[^\u0007\u001b]/.test(text) ? text : null
  }

  char(unit: { text: string; width: number }): void {
    this.row += unit.text
    this.column += unit.width
  }

  write(unit: Unit): void {
    if ('escape' in unit) this.escape(unit.escape)
    else this.char(unit)
  }

  /** The rest of the row in the style in force, where that style paints behind the text. */
  fill(): void {
    if (this.carry.filled && this.column < this.width) {
      this.row += ' '.repeat(this.width - this.column)
      this.column = this.width
    }
  }

  end(): void {
    this.out.push(`${this.row}${this.link ? '\u001b]8;;\u001b\\' : ''}\u001b[0m\r\n`)
    this.row = ''
  }
}

/** The units from `start` that stay together: a code point and those joined to it, or a single escape. */
function clusterAt(units: readonly Unit[], start: number): number {
  let end = start + 1
  if (!('text' in units[start])) return end
  while (end < units.length && 'joins' in units[end] && (units[end] as { joins: boolean }).joins) end++
  return end
}

/** A line as one row, as it was captured. */
function writeWhole(rows: Rows, units: readonly Unit[]): void {
  rows.start()
  for (const unit of units) rows.write(unit)
  rows.end()
}

/** A rule cut to one row: what passes the edge is only more of the same stroke. Its escapes are all kept. */
function writeClipped(rows: Rows, units: readonly Unit[]): void {
  rows.start()
  for (const unit of units) {
    if ('escape' in unit) rows.escape(unit.escape)
    else if (rows.column + unit.width <= rows.width) rows.char(unit)
  }
  rows.end()
}

/** A line cut at the edge, cell by cell as tmux cuts it, with no indent. */
function writeCut(rows: Rows, units: readonly Unit[]): void {
  rows.start()
  for (let index = 0; index < units.length;) {
    const end = clusterAt(units, index)
    const cluster = units.slice(index, end)
    const width = widthOf(cluster)
    if (width && rows.column + width > rows.width && rows.column > 0) {
      rows.fill()
      rows.end()
      rows.start()
    }
    for (const unit of cluster) rows.write(unit)
    index = end
  }
  rows.end()
}

/** The columns a continuation of this line is indented by: past its leading spaces and its marker. */
function hangOf(text: string, width: number): number {
  const lead = text.length - text.trimStart().length
  const marker = MARKER.exec(text.slice(lead))?.[0] ?? ''
  return Math.min(lead + columnsOf(marker), Math.floor(width * MAX_HANG_SHARE))
}

/**
 * A line wrapped at its spaces. The spaces a row ends at are dropped and any escapes among them kept; a word longer
 * than a row is cut between clusters; each continuation is indented by `hang`. Trailing spaces make no row of their
 * own: under a background they fill the row instead.
 */
function writeWrapped(rows: Rows, units: readonly Unit[], hang: number): void {
  // Runs of spaces and of words, an escape belonging to the run its next code point does (escapes at the end, to the
  // run before them).
  const runs: Array<{ space: boolean; units: Unit[] }> = []
  let pending: Unit[] = []
  for (const unit of units) {
    if ('escape' in unit) { pending.push(unit); continue }
    const last = runs.at(-1)
    if (last && last.space === unit.space) last.units.push(...pending, unit)
    else runs.push({ space: unit.space, units: [...pending, unit] })
    pending = []
  }
  if (pending.length && runs.length) runs.at(-1)!.units.push(...pending)
  else if (pending.length) runs.push({ space: true, units: pending })

  const dropSpaces = (run: readonly Unit[]): void => {
    let filled = false
    for (const unit of run) {
      if ('escape' in unit) rows.escape(unit.escape)
      else if (!filled) { rows.fill(); filled = true }
    }
  }
  // A block coloured from its first column (Codex's message from the person) keeps the colour under the indent of
  // each continuation, so it stays a rectangle; a diff's gutter has none, and neither does its continuation's.
  let colouredIndent: boolean | null = null
  const put = (unit: Unit): void => {
    if (colouredIndent === null && 'text' in unit) colouredIndent = rows.filled
    rows.write(unit)
  }
  const breakRow = (): void => {
    rows.end()
    rows.start(hang, colouredIndent === true)
  }
  const writeWord = (word: readonly Unit[]): void => {
    for (let index = 0; index < word.length;) {
      const end = clusterAt(word, index)
      const cluster = word.slice(index, end)
      const width = widthOf(cluster)
      if (width && rows.column + width > rows.width && rows.column > hang) {
        rows.fill()
        breakRow()
      }
      for (const unit of cluster) put(unit)
      index = end
    }
  }

  rows.start()
  let words = 0
  let spaces: Unit[] | null = null
  for (const run of runs) {
    if (run.space) {
      // Leading spaces are the line's own indent, written as they are up to the edge: a line of nothing but
      // (coloured) spaces, padding drawn for a wider pane, stays one row.
      if (words > 0) {
        spaces = run.units
        continue
      }
      for (const unit of run.units) {
        if ('escape' in unit) rows.escape(unit.escape)
        else if (rows.column < rows.width) put(unit)
      }
      continue
    }
    const width = widthOf(run.units)
    const gap = spaces ? widthOf(spaces) : 0
    // A word moves to the next row only from past the indent: at the indent the next row has no more room.
    if (rows.column + gap > hang && rows.column + gap + width > rows.width) {
      dropSpaces(spaces ?? [])
      breakRow()
    } else if (spaces) {
      for (const unit of spaces) put(unit)
    }
    spaces = null
    writeWord(run.units)
    words++
  }
  if (spaces) dropSpaces(spaces)
  rows.end()
}

/** Columns up to the last code point that is not a space. */
function reachOf(units: readonly Unit[]): number {
  let column = 0
  let reach = 0
  for (const unit of units) {
    if (!('text' in unit)) continue
    column += unit.width
    if (!unit.space) reach = column
  }
  return reach
}

/** `units` without its first `columns` columns of spaces, the escapes among them kept. */
function withoutIndent(units: readonly Unit[], columns: number): Unit[] {
  let dropped = 0
  return units.filter((unit) => {
    if (!('text' in unit) || dropped >= columns || !unit.space) return true
    dropped += unit.width
    return false
  })
}

/** `units` without the spaces after its last other code point, the escapes among them kept. */
function withoutTrailingSpaces(units: readonly Unit[]): Unit[] {
  const last = units.findLastIndex((unit) => 'text' in unit && !unit.space)
  return units.filter((unit, index) => index <= last || !('text' in unit))
}

/**
 * Codex lays a diff out itself: a line longer than the pane is cut at its edge, mid-word, and goes on in rows
 * indented to its gutter (`    22 +- … the board locks o` / `        nce the game is over.`). A space it cuts at is
 * dropped, so that row stops a column short (`plain HTML, CSS and some` / `        JS, two players`), while a space
 * right after a full row opens the next one; a wide character that does not fit leaves the last column empty. Seen
 * in codex 0.162.1's history, every row of it re-laid out at the pane's width (2026-10-13). Those
 * rows are separate lines to tmux, so -J cannot join them; they are joined here and wrapped by word like the rest.
 * Only a row that reaches the edge, then one indented to the gutter that is not a diff line of its own, is taken for
 * a continuation. `keepLast`: the last line runs on into the visible grid and is joined to nothing.
 */
function joinDiffRows(lines: readonly Unit[][], width: number, keepLast: boolean): Unit[][] {
  const end = keepLast ? lines.length - 1 : lines.length
  const joined: Unit[][] = []
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]
    const gutter = index < end ? GUTTER.exec(visibleText(line))?.[0] : undefined
    let row = line
    while (gutter && index + 1 < end) {
      const reach = reachOf(row)
      if (reach < width - 1 || reach > width) break
      const next = lines[index + 1]
      const text = visibleText(next)
      const columns = columnsOf(gutter)
      if (text.length - text.trimStart().length < columns || !text.trim() || GUTTER.test(text)) break
      const rest = withoutIndent(next, columns)
      const first = rest.find((unit): unit is Extract<Unit, { text: string }> => 'text' in unit)
      const droppedSpace = reach === width - 1 && first !== undefined && !first.space && first.width === 1
      line = [...withoutTrailingSpaces(line), ...(droppedSpace ? [SPACE] : []), ...rest]
      row = next
      index++
    }
    joined.push(line)
  }
  return joined
}

/**
 * The history's rows re-wrapped by word for `width`, as normalizeTmuxHistoryLines would write them, or null where
 * nothing needs it (no line is wider than the pane, the pane is too narrow) and the plain capture is sent instead.
 * `lastContinues`: the history's last line runs on into the visible grid's first row, so it is cut where tmux cuts
 * it and the grid's row carries on from there.
 */
export function rewrapTmuxHistory(joined: Uint8Array, width: number, options: { lastContinues: boolean }): Buffer | null {
  if (width < REWRAP_MIN_WIDTH || joined.length === 0) return null
  const text = Buffer.from(joined).toString('utf8')
  const lines = joinDiffRows(
    (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').map((line) => unitsOf(line.replace(/\r$/, ''))),
    width, options.lastContinues,
  )
  const continuing = options.lastContinues ? lines.length - 1 : -1
  if (!lines.some((units, index) => index !== continuing && widthOf(units) > width)) return null
  const rows = new Rows(width)
  lines.forEach((units, index) => {
    if (index === continuing) return writeCut(rows, units)
    if (widthOf(units) <= width) return writeWhole(rows, units)
    const visible = visibleText(units)
    if (RULE.test(visible)) return writeClipped(rows, units)
    if (isRigid(visible)) return writeCut(rows, units)
    writeWrapped(rows, units, hangOf(visible, width))
  })
  return Buffer.from(rows.out.join(''), 'utf8')
}
