import { describe, expect, it } from 'vitest'
import { cellAdvance } from './cellAdvance.js'
import { REWRAP_MIN_WIDTH, rewrapTmuxHistory } from './historyRewrap.js'

/** A `capture-pane -J -e` response as the control client decodes it: every line ends in a newline. */
const capture = (...lines: string[]): Buffer => Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8')
const rawRows = (rows: Buffer | null): string[] => rows!.toString('utf8').split('\r\n').slice(0, -1)
const strip = (text: string): string => text
  .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
const visibleRows = (rows: Buffer | null): string[] => rawRows(rows).map(strip)
/** Columns as the viewers' xterm.dart moves its cursor over the row. */
const columns = (row: string): number => [...row].reduce((sum, char) => sum + cellAdvance(char.codePointAt(0)!), 0)

describe('rewrapTmuxHistory', () => {
  it('leaves the history to the plain capture when no line is wider than the pane, or the pane is too narrow', () => {
    expect(rewrapTmuxHistory(capture('short line', '', '  └ also short'), 40, { lastContinues: false })).toBeNull()
    expect(rewrapTmuxHistory(capture('x'.repeat(30)), REWRAP_MIN_WIDTH - 1, { lastContinues: false })).toBeNull()
    expect(rewrapTmuxHistory(Buffer.alloc(0), 40, { lastContinues: false })).toBeNull()
  })

  // A reply Claude Code laid out for 160 columns, after a phone took the pane at 40 (2026-10-08): tmux had cut its
  // words in two at the edge, each continuation in column 0.
  it('wraps a message at its spaces, its continuations under the text past the mark', () => {
    const rows = rewrapTmuxHistory(capture(
      '⏺ I work right on your machine: I read and edit files, and run terminal commands. The main things:',
      '',
      '  - Write new features, fix bugs, refactor. I read the code around it first, then write in the style it already has.',
      '  ⎿  Read 3 files (ctrl+o to expand) and then a lot more words to make this line longer than forty',
      '    12 +  const veryLongVariableName = someFunctionCall(argumentOne, argumentTwo, argumentThree)',
    ), 40, { lastContinues: false })
    expect(visibleRows(rows)).toEqual([
      '⏺ I work right on your machine: I read',
      '  and edit files, and run terminal',
      '  commands. The main things:',
      '',
      '  - Write new features, fix bugs,',
      '    refactor. I read the code around it',
      '    first, then write in the style it',
      '    already has.',
      '  ⎿  Read 3 files (ctrl+o to expand) and',
      '     then a lot more words to make this',
      '     line longer than forty',
      '    12 +  const veryLongVariableName =',
      '          someFunctionCall(argumentOne,',
      '          argumentTwo, argumentThree)',
    ])
  })

  it('cuts a rule to one row and a table row cell by cell, as tmux does', () => {
    const table = '│ column A     │ column B, a bit longer  │ column C is long too │ column D    │'
    expect(visibleRows(rewrapTmuxHistory(capture('─'.repeat(118), table), 40, { lastContinues: false }))).toEqual([
      '─'.repeat(40),
      '│ column A     │ column B, a bit longer ',
      ' │ column C is long too │ column D    │',
    ])
  })

  it('keeps a coloured block a rectangle, and padding drawn for a wider pane one row', () => {
    const bg = '\u001b[48;5;236m'
    const rows = rewrapTmuxHistory(capture(
      `${bg}› hello world this is a long user message that goes beyond forty columns for sure ok${' '.repeat(35)}\u001b[49m`,
      `${bg}${' '.repeat(118)}\u001b[49m`,
    ), 40, { lastContinues: false })
    expect(visibleRows(rows)).toEqual([
      '› hello world this is a long user       ',
      '  message that goes beyond forty columns',
      '  for sure ok                           ',
      ' '.repeat(40),
    ])
    // The indent of a continuation is coloured too, and every row ends reset.
    expect(rawRows(rows)[1]).toBe(`${bg}  message that goes beyond forty columns\u001b[0m`)
    expect(rawRows(rows)[3]).toBe(`${bg}${' '.repeat(40)}\u001b[49m\u001b[0m`)
  })

  it('restores the style carried into each new row, after a plain indent', () => {
    const rows = rewrapTmuxHistory(capture(`  - \u001b[2m${'dim words '.repeat(6)}\u001b[22m`), 40, { lastContinues: false })
    expect(rawRows(rows)).toEqual([
      '  - \u001b[2mdim words dim words dim words dim\u001b[0m',
      '    \u001b[2mwords dim words dim words\u001b[22m\u001b[0m',
    ])
  })

  it('closes a link at the end of a row and opens it again on the next', () => {
    const open = '\u001b]8;;https://x.test\u001b\\'
    const close = '\u001b]8;;\u001b\\'
    const rows = rawRows(rewrapTmuxHistory(capture(`${open}${'link text '.repeat(6)}${close}`), 40, { lastContinues: false }))
    expect(rows[0]).toBe(`${open}link text link text link text link text${close}\u001b[0m`)
    expect(rows[1].startsWith(open)).toBe(true)
  })

  it('cuts a word longer than a row between clusters, never past the edge, never a wide character at its last column', () => {
    const rows = visibleRows(rewrapTmuxHistory(capture(
      `  https://example.com/${'a'.repeat(60)}`,
      `${'x'.repeat(39)}中文`,
      `${'a'.repeat(38)}👨‍👩 ê ${'y'.repeat(30)}`,
      `  ${'中文字符测试'.repeat(6)}`,
    ), 40, { lastContinues: false }))
    expect(rows).toEqual([
      `  https://example.com/${'a'.repeat(18)}`,
      `  ${'a'.repeat(38)}`,
      `  ${'a'.repeat(4)}`,
      'x'.repeat(39),
      '中文',
      'a'.repeat(38),
      `👨‍👩 ê ${'y'.repeat(30)}`,
      `  ${'中文字符测试'.repeat(3)}中`,
      `  文字符测试${'中文字符测试'.repeat(2)}`,
    ])
    for (const row of rows) expect(columns(row)).toBeLessThanOrEqual(40)
  })

  it('cuts the last line where tmux does when it runs on into the visible grid', () => {
    const rows = visibleRows(rewrapTmuxHistory(capture('word '.repeat(20).trimEnd(), `  ${'z'.repeat(88)}`), 40, { lastContinues: true }))
    expect(rows).toEqual([
      'word word word word word word word word',
      'word word word word word word word word',
      'word word word word',
      `  ${'z'.repeat(38)}`,
      'z'.repeat(40),
      'z'.repeat(10),
    ])
  })

  // Codex cuts a diff line at the pane's edge itself, mid-word, and goes on under its gutter (codex 0.162.1, a
  // 62-column pane, 2026-10-13); a space it cuts at is dropped, and that row stops a column short.
  it('joins the rows Codex cut a diff line into, and wraps it by word under its gutter', () => {
    expect(visibleRows(rewrapTmuxHistory(capture(
      '    22 +- Winning cells are highlighted, and the board locks o',
      '        nce the game is over.',
      '     5 +Build a tiny browser game in plain HTML, CSS and some',
      '        JS, two players share one device and take turns, X goe',
      '        s first.',
    ), 62, { lastContinues: false }))).toEqual([
      '    22 +- Winning cells are highlighted, and the board locks',
      '        once the game is over.',
      '     5 +Build a tiny browser game in plain HTML, CSS and some',
      '        JS, two players share one device and take turns, X',
      '        goes first.',
    ])
  })

  it('leaves a diff\'s gutter plain under a continuation, its text coloured', () => {
    const added = '\u001b[48;2;33;58;43m'
    expect(rawRows(rewrapTmuxHistory(capture(
      `    22 +${added}- Winning cells are highlighted, and the board locks o`,
      `        ${added}nce the game is over.`,
    ), 62, { lastContinues: false }))).toEqual([
      `    22 +${added}- Winning cells are highlighted, and the board locks  \u001b[0m`,
      `        ${added}o${added}nce the game is over.\u001b[0m`,
    ])
  })

  it('takes for a diff\'s continuation only a gutter-indented row after one that reached the edge', () => {
    const edge = '    22 +- Winning cells are highlighted, and the board locks o'
    expect(visibleRows(rewrapTmuxHistory(capture(
      edge, '    23 +- Choose',
      '    24 +- a short line', '        indented under it',
      edge, '      less indented',
      'x'.repeat(70),
    ), 62, { lastContinues: false })).slice(0, 6)).toEqual([
      edge, '    23 +- Choose', '    24 +- a short line', '        indented under it', edge, '      less indented',
    ])
    // The last line runs on into the visible grid: it is joined to nothing, and nothing else needs a re-wrap.
    expect(rewrapTmuxHistory(capture(edge, '        nce the game is over.'), 62, { lastContinues: true })).toBeNull()
  })

  it('does not re-wrap for the line that runs on into the grid alone', () => {
    expect(rewrapTmuxHistory(capture('short', 'z'.repeat(80)), 40, { lastContinues: true })).toBeNull()
  })
})
