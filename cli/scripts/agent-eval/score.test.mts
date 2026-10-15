// The transcript scorer (score.mts). Run: npx tsx --test scripts/agent-eval/score.test.mts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callsFromClaude, callsFromCodex, harnessVerb, score, type Case } from './score.mts'

const claude = (calls: Array<[string, string, boolean]>, answer: string): string[] => [
  ...calls.flatMap(([command, output, isError], i) => [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command } }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: output, is_error: isError }] } }),
  ]),
  JSON.stringify({ type: 'result', result: answer }),
]

test('finds the harness verb in a command, also by full path and inside bash -lc', () => {
  assert.equal(harnessVerb('harness ps'), 'ps')
  assert.equal(harnessVerb('~/.local/bin/harness wait reviewer --timeout 20m'), 'wait')
  assert.equal(harnessVerb("bash -lc 'harness new codex --name r -- go'"), 'new')
  assert.equal(harnessVerb('harness --help'), '--help')
  assert.equal(harnessVerb('ls harnesses/'), null)
})

test('reads Claude Code stream-json: commands, exit codes and the final answer', () => {
  const { calls, answer } = callsFromClaude(claude([['harness ps', 'rows', false], ['harness show x', 'Exit code 1\nNo harness named "x"', true]], 'done'))
  assert.deepEqual(calls.map((c) => [c.command, c.exit]), [['harness ps', 0], ['harness show x', 1]])
  assert.equal(answer, 'done')
})

test('reads Codex exec --json: command executions and the last agent message', () => {
  const { calls, answer } = callsFromCodex([
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: "bash -lc 'harness ps'", exit_code: 0, aggregated_output: 'rows' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex found two bugs.' } }),
  ])
  assert.deepEqual(calls.map((c) => [c.command, c.exit]), [["bash -lc 'harness ps'", 0]])
  assert.equal(answer, 'Codex found two bugs.')
})

const review: Case = { id: 'second-opinion', prompt: 'p', setup: 's', expect: { run: ['new', 'show'], answer: 'bug' } }

test('a clean run: one look, start, wait, read, close', () => {
  const { calls, answer } = callsFromClaude(claude([
    ['harness ps', 'rows', false], ['harness new codex --name r -- review', 'Created r', false],
    ['harness wait r', 'r: idle', false], ['harness show r', 'answer', false], ['harness close r', 'Closed r.', false],
  ], 'One bug in ledger.ts'))
  assert.deepEqual(score(review, 'claude', calls, answer), {
    id: 'second-opinion', agent: 'claude', calls: 5, firstAction: 1, orientation: 1, wrong: 0, retriesAfterRefusal: 0,
    leftOpen: 0, ranExpected: true, ranForbidden: [], answerOk: true, done: true,
  })
})

test('counts wrong options, retries after a refusal, and harnesses left open', () => {
  const { calls, answer } = callsFromClaude(claude([
    ['harness --help', 'Usage', false], ['harness version', '0.4.4', false],
    ['harness wait r --timout 5m', 'Exit code 2\nUnknown option --timout.', true],
    ['harness new codex --name r -- go', 'Exit code 1\nAgents may not start harnesses: the person turns on …', true],
    ['harness new claude --name r -- go', 'Exit code 1\nAgents may not start harnesses: the person turns on …', true],
  ], 'I could not'))
  const s = score({ ...review, expect: { notRun: ['new'], answer: 'person|turn on' } }, 'claude', calls, answer)
  assert.equal(s.orientation, 2)
  assert.equal(s.wrong, 1)
  assert.equal(s.retriesAfterRefusal, 1)
  assert.equal(s.answerOk, false)
  assert.equal(s.done, false)
})
