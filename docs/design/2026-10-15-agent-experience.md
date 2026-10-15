# Harness for agents, at first glance

October 15, 2026. Design, not built. Follows [Harness for agents](2026-10-11-agent-client.md).

## Goal

An agent that has never seen Harness (Claude Code, Codex, a script like the lamp's) can get from "is Harness
here?" to a finished task on another machine without guessing. At every step it knows four things:

1. **Where it is**: which agent it is, on which machine, inside or outside Harness.
2. **What it may do**: whether it can start harnesses, and how much of its limit is left.
3. **What the last command did**: what changed, on which machine, who can see it.
4. **What to run next**: the exact command, for every result and every error.

**Success:** in the eval (part 9), a Claude Code and a Codex agent that have never seen Harness finish a
two-machine task with no wrong command and no command run only to find out where they are. Today's baseline is
measured first.

**Not in scope:** the core daemon, the windows, the TUI's own command language, new limits or new permissions.

## What an agent sees today (CLI 0.4.4, the owner's Mac, October 15)

| Moment | What it sees | What is missing |
|---|---|---|
| `harness --help` | about 100 lines; the agent verbs sit between `login`, `flash` and `grid` | a short page for agents |
| `harness ps` | `You are "<name>" (<id>).`, then 40 rows, nearly all the person's idle harnesses | the machine; that starting is off; how much of its limit is left; what to do next |
| `harness machines` | `AGENTS 0` on every machine, also this one with 40 harnesses | what the number counts; which machines it can reach |
| `harness settings` | three switches, all off | that only the person can turn them on |
| `harness new` with starting off | refused, with how the person turns it on | it learns this only by trying |
| `harness wait` | a state and a next step per harness (good) | `gone` has no next step |
| errors | each says what to run next (good) | keep this |
| `npx -y @autonomous-ai/harness-mcp` (in `llms.txt` and `/agents`) | npm 404: never published | |

What already exists and is reused: `agentOrigin()` (who calls), `SPAWN_LIMITS` and `spawnRefusal()` (the limits,
and whether a start would be refused), `agent-settings.json` (the switches), `step()` (the next command, written as
a CLI command or as an MCP tool call), `AgentClientError` codes, the MCP tool annotations.

## What other tools do (quick survey, October 15)

| Pattern | Who | Taken here as |
|---|---|---|
| a "who and where am I" command | `gh auth status`, `kubectl config current-context`, `vercel whoami` | `harness whoami` (part 1) |
| the state after every action | Playwright MCP returns the page after each action | every verb ends with the state and Next (part 2) |
| a state for "waiting on a person" and for "refused" | A2A task states `input-required`, `auth-required`, `rejected` | `needs-person`, `signed-out`, `refused` (part 3) |
| exit codes that hold in JSON mode too | `gh` (pitfall: exits 0 on many errors in JSON mode) | same exit codes with `--json` (part 3) |
| text plus typed fields | MCP `structuredContent` with `outputSchema` | MCP returns both (part 6) |
| a read-only mode | GitHub MCP `--read-only` | `harness mcp --read-only` (part 6) |
| completion is a signal, not a guess | Claude Code notifies the parent; models claimed "done" before the signal | only `wait` / `show` say done (part 2) |
| prototype, eval, then improve | Anthropic, "Writing effective tools for agents" | part 9 |

Read at summary level: [gh auth status](https://cli.github.com/manual/gh_auth_status),
[Playwright MCP snapshots](https://playwright.dev/mcp/snapshots),
[A2A task states](https://a2aprotocol.ai/docs/guide/a2a-protocol-specification-python),
[MCP 2025-11-25 changes](https://workos.com/blog/mcp-2025-11-25-spec-update),
[MCP Tasks extension](https://aaif.io/blog/handle-long-running-mcp-tool-calls-with-the-mcp-tasks-extension),
[GitHub MCP configuration](https://glama.ai/mcp/servers/@github/github-mcp-server/blob/bf6467855c13d3b8f5cf72f8dfd9c86f8336b20b/docs/server-configuration.md),
[Anthropic, Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents).

## Part 1. The context block: where am I, what may I do

Three lines at most:

```
You: Claude Code "lead" (94d984ee), inside Harness, on Mac Auto.
Can start harnesses: no. The person has not turned on "Agents can start other agents". Ask them to run: harness settings agents-start-agents on
Yours: 1 open of 4 · 3 of 20 starts in the last 10 minutes · other machines: office, grid-dev (running)
```

Line 2, by case, in the order `spawnRefusal()` checks them:

| Case | Line 2 |
|---|---|
| allowed | `Can start harnesses: yes.` |
| switch off | as above |
| this computer signed out | `Can start harnesses: no. This computer is signed out of Harness, and starting is the account's choice. Ask the person to run: harness login, then harness settings agents-start-agents on` |
| started by an agent (depth) | `Can start harnesses: no. An agent started you, and only one level is allowed. Do the work yourself, or say in your answer what else is needed.` |
| 4 open | `Can start harnesses: no. You have 4 open, the most. Close one you are done with: harness close <name>` |
| 20 starts in 10 minutes | `Can start harnesses: not until 14:32 (20 starts in 10 minutes).` |
| a pane whose harness is gone | `Can start harnesses: no. This pane's harness is no longer running. Only the person can start or close harnesses here.` |
| a person | line 2 and 3 left out |

Outside Harness, line 1 reads `You: Codex, outside Harness, on Mac Auto. Nothing can message you here.`

**Where it is shown**

| Where | What |
|---|---|
| `harness whoami` (new verb) | the block; `--json` gives `context` alone |
| top of `harness ps` | the block, for an agent, replacing today's `You are …` line; a person's `ps` is unchanged |
| `new`, `show`, `wait`, `close` | not the block; their result names the machine instead (part 2) |
| `--json` of `ps` and `whoami` | `context` (below) |
| MCP | the block at connect time, in `initialize` `instructions`; and a `harness_whoami` tool |

```json
"context": {
  "caller": { "kind": "agent", "agent": "Claude Code", "name": "lead", "id": "94d984ee…", "inside": true, "machine": "Mac Auto" },
  "canStart": { "ok": false, "reason": "SWITCH_OFF", "fix": "harness settings agents-start-agents on", "fixBy": "person" },
  "quota": { "open": 1, "maxOpen": 4, "starts": 3, "maxStarts": 20, "windowMinutes": 10, "depth": 0, "maxDepth": 1 },
  "machines": [ { "name": "office", "state": "running" }, { "name": "grid-dev", "state": "running" } ]
}
```

`reason` is one of `SWITCH_OFF`, `DEPTH`, `OPEN_LIMIT`, `START_RATE`, `ORPHAN`; `fixBy` is `person` or `you`.

**Cost.** Switches and the record of starts are local files. The machines line uses the account's machine list
the daemon already holds; it does not ask each machine, so `ps` stays fast. The count of this agent's harnesses
on other machines stays exact only in `new`, as today, so the header can say "1 of 4" where `new` counts 2; `new`
still refuses correctly and says so.

## Part 2. Every verb answers the same way: result, effect, Next

Each verb's text ends with:

- **Result**: one line, `<name> on <machine>: <state>`.
- **Effect**, only when something changed: what, and who sees it.
- **Next**: `Next: <command>`, one to three lines, each with when to pick it.

| Verb | Result and effect | Next |
|---|---|---|
| `new` | `reviewer on office: starting. Codex, in ~/harnesses/review. The person sees it in Harness, beside you.` | `Next: harness wait --machine office reviewer` (then read it with `harness show`) |
| `new`, held for an install | `reviewer on office: installing Codex (about 1 minute).` | `Next: harness wait --machine office reviewer. Do not start it again.` |
| `ps` | the block, then rows: yours first, then working or waiting, then the rest (part 4) | none open: `Next: harness new …`; one idle: `Next: harness show <name>, then harness close <name>` |
| `show` | `reviewer on office: idle · asked … · answer …` | yours and idle: `Next: harness close --machine office reviewer`; working: `Next: harness wait …`; needs the person: `Next: tell the person; only they answer it` |
| `wait` | one line per harness (today's lines) | adds a Next to `gone`: `Next: harness ps --all --machine office, to see if it was closed` |
| `close` | `reviewer on office: closed. Its conversation is kept; the person can resume it.` | `Next: nothing; you have 0 open of 4.` |
| `send` | `sent to tests (read 14:02)` | `Next: harness wait tests` |
| `whoami` | the block | when it cannot start: who must do what |

Rules:

- A command is written with `step()`, so it is a shell command for the CLI and a tool call for MCP.
- `Next` names only what the caller may run. A harness the caller did not start never gets `close` as Next.
- **Done is said only by `wait` and `show`.** `new` says `starting`, never `started the task`, and `send` says
  `sent`, never `done`.
- `--json` adds the same, as fields: `"effect": "…"` and `"next": [{ "run": "harness wait …", "when": "to get its answer" }]`.
  Additive: no field is renamed or removed.

## Part 3. States and exit codes

One set of states, the same words in `ps`, `show`, `wait`, `--json` and MCP:

| State | Means | Exit (`wait`) | Next |
|---|---|---|---|
| `installing` | Harness is installing the agent on that machine | 124 when the wait ends | wait again |
| `starting` | the agent is opening | 124 | wait again |
| `working` | busy | 124 | wait again |
| `needs-person` | a question or a permission only the person answers | 3 | tell the person |
| `signed-out` (new) | the agent on that machine is not signed in to its provider | 3 | tell the person: `codex login` on office |
| `idle` | finished its turn | 0 | `show`, then `close` |
| `closed` | the caller closed it | 0 | none |
| `stopped` | stopped by the person, or by the idle cleanup | 4 | `show` still reads its answer |
| `gone` | no longer on its machine | 4 | `ps --all` |
| `failed` | never started, with why | 4 | fix what it says, or tell the person |

- Text says `needs the person`; `--json` keeps `needs-input` and adds `"needsPerson": true`, so nothing that reads
  today's JSON breaks.
- **`signed-out` needs work first**: Harness does not detect it today. Phase 6 adds it from what the agent's screen
  shows at start (Codex and Claude Code print a sign-in prompt), only where it is detected reliably; otherwise
  it stays `needs-person`.
- **Refusals** (`SPAWN_LIMIT`, `NOT_YOURS`, the switch off) exit **5** (new; today 1) with the error code in
  `--json` (`{"error": {"code": "SPAWN_LIMIT", "reason": "OPEN_LIMIT", "message": "…", "next": [...]}}`). A refusal
  is not a failure: the agent should not retry, it should tell the person or do the work itself.
- Exit codes are the same with or without `--json`. They are listed in one place: `harness help agents`.

## Part 4. Less to read: `ps` and the help

**`ps`** by default shows, after the block:

1. the caller's own harnesses, every state;
2. harnesses working or needing the person;
3. the rest of the live ones, up to 15 rows in total;

then one line: `and 31 more, idle: harness ps --all`. A person running `ps` sees all live ones, as today.
On the owner's Mac this cuts `ps` from 40 rows to about 8.

**`harness help agents`** (new): at most 40 lines. The block's meaning, the six verbs with one example each, the
states and exit codes, the limits, the rules. It is generated from the same strings as each verb's usage, so it
cannot drift.

**`harness --help`**: its first lines say `An agent? Run: harness help agents`. When the caller is an agent (its
pane, or `AI_AGENT` / `HARNESS_AGENT_SESSION` set), the agent section is printed first.

**`harness machines`**: the `AGENTS` column counts live harnesses (it says 0 today), and a new column says whether
this machine can reach it now: `yes`, `offline`, `older Harness (0.3.x): update it`.

## Part 5. Across machines

- **`ps --machine all`**: every reachable machine, one section each, the block once. A machine that does not answer
  in 3 seconds is listed as `not answering` and skipped.
- **Clean up across machines**: closing a harness closes the harnesses it started on other machines too, through
  the same relay `close --machine` uses. Today each machine's cleanup sees only its own.
- **Older Harness on the other machine**: `new --machine` says so before it starts and names the update
  (`harness update` on office), instead of a vague failure.
- **Fix from #1333**: `ps`/`show --machine` label a harness that machine's own agent started as "started by person";
  read who started it from that machine's record.

## Part 6. MCP

- Each tool returns its text **and** `structuredContent` with the `--json` fields, and declares `outputSchema`.
  Clients that read only text see the same as today.
- `harness_whoami` (read-only) returns the block.
- `instructions` in `initialize` carries the block as it is at connect time, then the rules.
- `harness mcp --read-only` serves only `harness_whoami`, `harness_list`, `harness_read` and `harness_wait`, for an
  agent that should only watch.
- Annotations stay as they are (`list`, `read`, `wait` read-only; `close` not destructive and idempotent;
  `start` and `send` not destructive). `harness_whoami` is read-only.
- Not now: MCP Tasks (spec 2026-07-28) for `harness_start`; added once Claude Code and Codex support it.
  `harness_wait`'s "call again" stays.

## Part 7. Being found

| Step | Who | What |
|---|---|---|
| 1 | us, now | `llms.txt` and `/agents` stop telling agents to run the npm package until it is published |
| 2 | owner | publish `@autonomous-ai/harness-mcp` to npm (an `autonomous-ai` npm org account) |
| 3 | us | the CLI release workflow builds `harness-mcp.mcpb` and attaches it, so it is not a manual step (`make mcpb` today) |
| 4 | owner | publish `server.json` to the Official MCP Registry (`io.github.autonomous-ai/harness`) |
| 5 | us | Smithery, Glama and the lists in `docs/research/2026-10-11-listing-submissions.md` |
| 6 | us | `llms.txt`, `SKILL.md` and `/agents` lead with `harness whoami` as the first command |

**One source of truth test**: `website/scripts/listings.spec.ts` already checks the listing files. Add a check that
every verb and option in `llms.txt`, `SKILL.md` and `/agents` exists in the CLI's usage, and every agent verb is in
all three. #1333 had to fix `@mini` in two of them by hand; this test would have caught it.

## Part 8. Docs that change with the code

`plugins/harness/skills/harness/SKILL.md`, `website/public/llms.txt`, `website/public/agents/index.html`,
`docs/cli.md`, `docs/design/2026-10-11-agent-client.md`, `harness --help`, each verb's usage. Each phase updates
the ones it touches; the test in part 7 fails otherwise.

## Part 9. Proving it: the eval

Extends the eval in the agent-client design (`cli/scripts/route-eval/` style).

- **Agents**: Claude Code and Codex, a fresh session each, given only `llms.txt` (outside Harness) or nothing but
  being in a pane (inside).
- **Tasks** (8): get a second opinion from Codex on this machine; run tests on `office` and report; the switch is
  off (right answer: tell the person); the limit is full; a harness needs the person; read a harness the person
  started (right answer: read, do not close); a machine is offline; the agent on `office` is signed out.
- **Measured from the transcript**: commands until the first useful one, wrong commands, commands run only to find
  where it is, retries after a refusal (should be 0), harnesses left open at the end (should be 0), task done.
- **Before and after**: run on today's CLI first for the baseline, then after each phase. Real machines, the
  owner's account, at most 2 harnesses per run; the person approves each run.

## Phases (one pull request each)

| # | Phase | Size | Depends on |
|---|---|---|---|
| 1 | Docs stop the broken `npx` line; the one-source-of-truth test | S | none |
| 2 | Eval harness and today's baseline | M | none |
| 3 | Context block: `whoami`, the `ps` header, `context` in JSON, MCP `harness_whoami` and `instructions` | M | none |
| 4 | Result, effect, Next on every verb; `next` and `effect` in JSON; `gone` gets a Next | M | 3 |
| 5 | States and exit codes: `needs-person` wording, refusals exit 5 | S | 4 |
| 6 | `signed-out` detection (only where reliable) | M | 5 |
| 7 | Less to read: `ps` default, `harness help agents`, `--help` first lines, `machines` columns | M | 3 |
| 8 | MCP: `structuredContent`, `outputSchema`, `--read-only` | S | 4 |
| 9 | Across machines: `ps --machine all`, cross-machine cleanup, older-Harness check, the #1333 label | L | 3 |
| 10 | Publishing: npm, `.mcpb` in the release, the registry, listings | S (owner steps) | 1 |
| 11 | Eval after: compare with the baseline | S | 3 to 8 |

Phases 1, 2 and 3 can start together. Each phase adds its specs to `cli/src/agentClient/*.spec.ts` (a spec per
new line of text, failing against main), runs `npx vitest run src/agentClient src/lib/newCommand.spec.ts`, and the
CLI end to end once for phases 4, 5 and 9.

## Compatibility

- JSON only gains fields. `needs-input` stays in JSON.
- Text changes: agents read it, scripts should use `--json`. The skill, `llms.txt` and `/agents` change in the same
  pull request.
- **Exit 5 for refusals is the one breaking change**: a script that treats any non-zero as failure is unaffected; one
  that checks `== 1` for a refusal changes. Said in the release notes.

## Decided (October 15)

1. `harness whoami`: the word agents already try (`gh`, `vercel`, `wrangler`); `status` stays the daemon's.
2. Refusals exit 5, with the JSON `code`.
3. `ps` for agents: up to 15 rows, ordered as in part 4.

Open: phase 10's npm and registry steps need the owner's accounts (who and when).
