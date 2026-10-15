# Codex in the terminal's scrollback

Status: implemented in `cli/` on `feat/engine-scrollback`. The desktop and mobile apps and the backend are
unchanged.

Harness now launches Codex with its full-screen transcript turned off, so Codex's conversation lives in the
terminal's own scrollback. On a phone that means native scrolling, Find and selection over the whole
history, and no composer pinned to the foot of the pane. Running an agent in the scrollback of a pane that
a desktop and a phone take turns resizing raised three problems, and the daemon now fixes all three:

- history cut short;
- words cut in two;
- a flash on every keyboard raise and lower.

Claude Code is left exactly as the person set it up, for a reason given below.

## Background

One tmux pane runs each agent, and every client draws that pane: the desktop window, the phone, the hn TUI
and Share observers. One client controls the pane at a time, and its grid sets the pane's size
(`resize-window` on every takeover; the phone also resizes it when its keyboard comes up or goes down). A
client never keeps its own copy of the screen across a resize. It rebuilds its terminal from a keyframe:
the visible grid, plus history rows that seed its local scrollback (`lib/tmuxStream.ts`
`synthesizeTmuxSnapshot`).

Codex 0.157 made its full-screen transcript the default (`tui.fullscreen_transcript`; 0.156 added it as an
option, released 2026-09-22 and 2026-09-25). In that mode Codex owns the alternate screen:

- its composer and status line are pinned to the foot of the pane, and a `↓ Back to bottom · esc` pill
  covers the last line when the transcript is scrolled;
- the client has no history at all, since tmux keeps none on the alternate screen. Every scroll gesture
  is a mouse report sent to Codex and drawn back over the relay;
- Find on the desktop, selection, link detection and the phone's long-press only ever see one screen.

On a phone the pinned chrome takes a large share of the rows, and scrolling is only as smooth as the round
trip.

## Decision: Codex runs in its scrollback

`engines/codex/launch.ts` declares a `screen` on its launch contract (`facets/launch.ts` `ScreenContract`):

```ts
screen: {
  args: ['-c', 'tui.fullscreen_transcript=false'],
  resizeRepaint: { clears: '\u001b[3J', ends: '\u001b[?2026l', withinMs: 250 },
}
```

`kit/launchScreen.ts` applies it to every launch: `buildEngineCommandArgv` puts the args ahead of the
launch's own extra arguments. Every path goes through it: create, restart, retarget, resume, fork, restore,
external preflight, the Codex startup retry (`"$@"`), and `harness shell-launch` for a `codex` typed at an
hn prompt.

- **`-c` rather than `--no-alt-screen`.** `--no-alt-screen` also turns Codex's overlays inline, its
  transcript pager among them. `-c` outranks the person's `config.toml` and profiles: against 0.162.1,
  `=true` in the config with `=false` on argv leaves the alternate screen off.
- **Older Codex.** 0.146.0 and 0.155.1 have no such key. They start exactly as they would without it.
- **Per engine, not per viewer.** The screen is decided when the engine process starts, and one process
  serves every viewer. Switching it per controlling client would mean restarting the engine on every
  takeover, which would cut off a running turn.

## Consequences, and what fixes them

### 1. The history was cut short (500 → 2000 rows)

A keyframe seeded the last 500 rows of tmux history. With the conversation in the scrollback, that was the
last few screens of a long reply: a phone opened on a pane with 544 history rows began 44 rows into it.

An engine with a declared screen now gets `conversationHistory` from the stream manager
(`lib/terminalStreamManager.ts`). Its keyframe seeds up to `CONVERSATION_HISTORY_LINES = 2000` rows, which
is tmux's own `history-limit` (Harness leaves it at the default). Keyframes stay within
`KEYFRAME_MAX_BYTES` (480 KiB, now in `terminalTypes.ts`): if the keyframe is over, the oldest history rows
are dropped (`dropOldestHistoryRows`). Each row restores the style carried into it, so any row can start
the history.

Other panes keep the 500 rows they always had, byte for byte.

### 2. Words were cut in two (re-wrap by word)

**The cut.** tmux re-wraps its history by the cell when a pane narrows. A reply laid out at 160 columns
reached a 40-column phone as `… I read a` / `nd edit files …`, with every continuation in column 0. Column 0
matters beyond looks: the phone's long-press takes a message to end at the next row with anything in
column 0 (`mobile/lib/terminal/output_blocks.dart`).

Codex also lays out diffs itself. It cuts a long diff line at the pane's edge, mid-word, and continues it
in rows indented to the gutter (`    22 +- … locks o` / `        nce the game is over.`). Those are hard
line breaks, which tmux cannot join.

**What the keyframe does instead.** For a conversation, it reads the history twice:

- once as tmux holds it;
- once joined back into logical lines (`capture-pane -J`).

It also probes the seam: `-J -S -1 -E 0` returns one line if the last history row runs on into the visible
grid. The three must read the same history:

- **One write.** `ControlCommandQueue.runTogether` writes the three lines to tmux in one write. tmux runs
  every line it read at once before it reads the pane again. Against a pane printing as fast as it could,
  output was read between the three in 28 of 500 tries when written one line per write, and in 0 of 500
  when written together (tmux 3.7c).
- **Checked, not assumed.** tmux sends a pane's output and command replies in the order they happened. The
  stream counts the pane's output notifications at the first capture's `%end` and at the last one's. If they
  differ, the three are read again; if they differ a second time, the history goes as tmux has it.
- **Not one line joined with `;`.** tmux answers each command of a list with its own `%begin`/`%end`, and
  none after one that fails. The queue, which also carries keystrokes, could no longer pair replies with
  commands.

`lib/historyRewrap.ts` then writes the history again:

- **Measure as the viewer does.** `cellAdvance.ts` ports xterm.dart's Unicode 11 wide table. xterm.dart
  advances one column for every code point it is handed (marks, joiners and selectors included) and two
  for a wide one. It does not clip a row that is too wide: it carries the rest onto a row of its own. So
  every row is built to fit exactly, and a wide character is never put in the last column.
- **Classify each logical line.**
  - Lines that fit are left as they are.
  - Rules are cut to one row.
  - Tables and frames (three or more box-drawing or `|` characters) are cut cell by cell, as tmux does.
  - Everything else is wrapped at its spaces. A word longer than a row is cut between clusters (a base and
    its marks, ZWJ sequences, selectors and modifiers stay together).
- **Hanging indent.** A continuation is indented past the line's leading spaces and one marker: a message
  mark (`⏺ ● •`), a bullet or number, a tree mark (`⎿ └`), a prompt (`› ❯`), or a diff gutter and sign. The
  indent is capped at 40% of the width. These are the indents the engines give their own wrapped lines,
  and the phone's long-press and copy rely on them.
- **Colour.**
  - Trailing spaces never make rows. Under a background they fill the row, so coloured blocks stay
    rectangular.
  - The indent takes the colour only for a block coloured from its first column (Codex's message from the
    person); a diff's gutter stays plain.
  - Each row restores the SGR carried into it (`sgrCarry.ts`), and an open OSC 8 link is closed at the end
    of a row and opened again on the next.
- **Codex's diff rows are joined first** (`joinDiffRows`).
  - A row is joined to the next only when it has a gutter and reaches the edge, and the next row is
    indented to the gutter and has no gutter of its own.
  - A row one column short means Codex dropped the space it cut at, so the join adds a space back. Where a
    full row is followed by a space, Codex starts the next row with that space: indent G+1, 38 of 264 cuts
    in live panes. Removing exactly G columns keeps it.
  - A row is joined only when it was cut at the current width. Codex lays its history out again at the
    pane's width on every resize.
- **Edges.**
  - A last line that runs on into the grid is cut as tmux cuts it.
  - The first line may start mid-line and is treated as prose.
  - Panes narrower than 20 columns are left as tmux has them.
- **Fallback.** If no line is wider than the pane, or anything throws, `rewrapTmuxHistory` returns null
  and the keyframe is today's bytes.

Only the history is rewritten. The visible grid is still the engine's to address with its cursor, so it is
sent exactly as tmux holds it.

### 3. The screen flashed on every resize

**What Codex does.** In its scrollback, Codex 0.162.1 answers every resize by printing its transcript
again. A phone's keyboard going up or down is a resize. About 80 ms after the resize it writes
`ESC[H ESC[2J ESC[3J ESC[H`, clearing the screen and the scrollback outside its synchronized update. It then
reprints the whole transcript inside one synchronized update (`ESC[?2026h … ESC[?2026l`).

**Why the phone flashed.** A keyframe was taken 10–40 ms after the resize. The clear and the reprint
(about 16 KiB in a medium session) followed as live output, and the phone drew the cleared screen in
between.

**The fix.**

- **The wait.** Codex declares `resizeRepaint`. `TmuxControlStream` records when it really changed the
  pane's size (`resizedAt`). A snapshot taken within `withinMs` (250 ms) of that waits for the clear, then
  for the first `ESC[?2026l` after it, and gives up 400 ms after it saw the clear (`REPAINT_MAX_MS`).
  Output meanwhile is held behind the snapshot gate, and what precedes the capture's cut is the capture's.
  The clear never leaves the daemon, and the keyframe holds the reprinted screen.
- **A print under way at the cut.** The clear can come after the wait gave up, or where there was no wait
  to make, and still before the capture's cut. The cut then discards it, and the capture holds a cleared or
  half-printed screen. So the output the cut discards is read for the print (`printInProgress`). If the
  print began there and had not ended, the snapshot waits for its end and is taken again; only that
  keyframe is sent.
- **The guard.** For 1.5 s after a keyframe for an open or a resize (`REPAINT_GUARD_MS`), the stream
  manager watches live output for the clear. If it arrives anyway (a Codex at work answered later than the
  wait), the chunk and anything unsent are dropped, and a keyframe waits for the reprint's end. If the end
  came in the same chunk, the keyframe is taken at once.
- **The output a keyframe held back is live output too.** After a keyframe is sent, the output that followed
  its cut is released, and it is read for the clear like any live output. The manager marks the keyframe as
  done before releasing that output. If a keyframe for the print begins partway through the release, the
  stream holds the rest behind that keyframe's gate: it precedes the new cut, so the capture holds it.
- **Reading the end, not a pause.** A first version waited for a 50 ms pause in the output. A Codex at work
  redraws its `Working (…)` line continuously and never pauses, so every resize keyframe ran to the 1.5 s
  cap, holding the phone's echo of what was typed (`snapshotMs` 1536–1585 in the daemon's log).

## Claude Code is not changed

Claude Code runs as the person set it up (`"tui"` in its settings, `CLAUDE_CODE_NO_FLICKER`,
`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`). Harness sets and clears nothing for it, and its keyframes are
unchanged.

Running it in the scrollback was tried and dropped:

- **The duplication.** On a narrower pane, Claude Code 2.1.296's inline renderer erases only the rows on
  screen (`ESC[H`, then `ESC[2K` row by row) and paints its frame again. It starts from a row it computes
  as if the terminal had left the scrollback untouched. tmux re-wraps the scrollback, so part of the
  conversation is printed twice, with fragments between. Narrowing from 80 to 50 columns added 267
  duplicate lines; widening and height changes added none.
- **No way around it.** No Claude Code setting changes this behaviour, `Ctrl+L` only redraws the frame,
  and tmux cannot be told not to re-wrap.
- **The alternatives.** Clearing tmux history on each narrowing would lose all but the reprinted tail.
  Deduplicating text heuristically cannot be exact, because the reprint has different line breaks and
  fragments.

Forcing full screen was implemented and then removed at the product owner's request: Harness should not
override the person's own choice for Claude Code.

## Alternatives considered

| Option | Why not |
| --- | --- |
| Keep Codex full screen and polish the phone's remote scrolling | Pinned chrome on a small screen, a round trip per scroll gesture, and Find and selection still limited to one screen |
| A different screen per viewer (full screen on the desktop, scrollback on the phone) | One engine process serves every viewer; switching means restarting the engine on every takeover |
| A per-machine setting | No one has asked for Codex full screen inside Harness. The contract makes it a small change if they do |
| `--no-alt-screen` | Also turns Codex's overlays and pager inline |
| Re-wrap on the phone | The keyframe sends hard rows, so the phone cannot tell a wrap from a newline. Doing it in the daemon fixes the desktop, hn and Share observers too |
| Detect the end of Codex's reprint by a pause in output | A Codex at work never pauses (above) |
| Rely on the viewer honouring synchronized output (DEC 2026) | The clear is outside the synchronized block, and xterm.dart does not implement it |

## Trade-offs

- **Codex loses its full-screen-only features inside Harness:** transcript search and copy inside Codex,
  and Codex's own mouse selection. Harness's Find and selection now cover the whole history instead.
- **The visible grid is not re-wrapped.** Right after a takeover, rows still on screen keep tmux's cut
  until they scroll into history and a later keyframe arrives (an open, a resize or a keyboard toggle).
  Codex's own reprint usually repairs them first.
- **Resize keyframes for Codex arrive later:**
  - 100–112 ms idle, about 185 ms in a long session at work, at most 400 ms after the clear;
  - a print caught under way at the capture's cut costs one more capture, after waiting up to another
    400 ms for its end;
  - a Codex with no transcript to reprint costs the full 250 ms wait;
  - typed echo is held for that window, and only right after a resize.
- **Heavier keyframes for Codex panes.** 2000 rows at 40 columns measured 103 KiB and about 32 ms to
  snapshot, against 27 KiB and about 12 ms for 500 rows. A long session reached about 230 KiB. The phone
  parses keyframes in slices, but there is more to parse on every open and every keyboard toggle.
- **Dependence on Codex's output.** If a later Codex stops writing `ESC[3J`, the wait ends after 250 ms
  and the flash may return. If it stops closing with `ESC[?2026l`, the wait ends at 400 ms. Neither breaks
  a stream.
- **The diff join is a heuristic.** A full-width diff line followed by an unrelated row indented exactly
  to the gutter would be joined. This only affects the history the viewer sees; tmux is untouched.

## Measurements

| What | Before | After |
| --- | --- | --- |
| History seeded, pane with 544 rows | last 500 (44 lost) | all 544 |
| Snapshot, 500 rows at 40 cols | 11.5 ms | 15.3 ms (re-wrapped) |
| Snapshot, 2000 rows at 40 cols | n/a | 32 ms, 103 KiB |
| Keyframe after a keyboard toggle (idle Codex) | 21–25 ms, then 16 KiB live incl. the clear | 100–112 ms, 43 bytes live, no clear |
| Keyframe after a keyboard toggle (Codex at work) | first fix, pause-based: 1536–1585 ms | read off the end: ≤ 400 ms (about 185 ms observed) |

## Diagnostics

`keyframe_sent` now logs `reason`: `open`, `resize`, `resync`, `input` (a write that may have run) or
`repaint` (the guard above). Together with `snapshotMs` and `plainBytes`, this shows what asked for a slow
keyframe.

## Testing

- **New specs:**
  - `lib/historyRewrap.spec.ts`: prose, lists, diffs, rules, tables, coloured blocks, SGR carry, OSC 8,
    long words, wide characters, clusters, the seam, and Codex diff joins;
  - `lib/cellAdvance.spec.ts`;
  - `engines/kit/launchScreen.spec.ts`.
- **Updated specs:**
  - `lib/engineLaunch.spec.ts` and `shellLaunch.spec.ts`;
  - `lib/terminalStreamManager.spec.ts`: options, the repaint guard, `reason`, and a clear in the output a
    keyframe held back;
  - `lib/tmuxStream.spec.ts`: `dropOldestHistoryRows`, `printInProgress`, and `runTogether` (one write,
    replies still paired, failures).
- **Real tmux** (`lib/tmuxStream.real.spec.ts`, `RUN_REAL_TMUX_STREAM=1`):
  - a conversation's history seeded whole and re-wrapped;
  - a pane script that clears and reprints on SIGWINCH while animating a status line every 20 ms;
  - a print still under way at the capture's cut, taken again once it ends;
  - the rest of a release held behind a snapshot its sink begins.

  On macOS run it with a short `TMPDIR`, or tmux's socket path is too long.
- **Golden launch records re-recorded** (`RECORD_LAUNCH_GOLDEN`, `RECORD_LAUNCH_SHAPES_GOLDEN`,
  `RECORD_DSH_LAUNCH_SHAPES_GOLDEN`, `RECORD_NATIVE_LAUNCH_GOLDEN`). With Codex's two screen args removed,
  every record equals the previous one. Claude Code's records are unchanged.
- **Manual checks:**
  - Codex 0.146.0, 0.155.1 and 0.162.1 with the flag, in an isolated tmux;
  - Codex resize timing, raw output and repaint;
  - Claude Code 2.1.296 resize behaviour;
  - a phone and a desktop against a dev daemon (`make install-cli`).

## Rollout

- Agents already running keep their screen until they are restarted; new and restarted Codex agents run in
  the scrollback.
- Nothing is stored or migrated, and reverting the change restores the old launch and keyframes.

## Follow-ups

- Have the fake Codex in `e2e/harness/fakeEngine.mjs` honour `-c tui.fullscreen_transcript=false`; its
  `!browse` still draws full screen.
- Measure keyframe parse time on a phone with 2000-row Codex history, and lower
  `CONVERSATION_HISTORY_LINES` if keyboard toggles feel heavy.
- If Codex adds a way to stop clearing the scrollback on resize, drop `resizeRepaint`.
