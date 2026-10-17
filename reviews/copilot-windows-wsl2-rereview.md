Overall verdict: File

Per-blocker status

1. Blocker 1: Closed
   - The original `Platform` misuse is fixed in the desktop app: `desktop/lib/core/viewer_mode.dart` now gates on `RuntimePlatform.isIOS`, `RuntimePlatform.isAndroid`, and `RuntimePlatform.isWindows` instead of bare `Platform` references (`desktop/lib/core/viewer_mode.dart:15-20`).
   - The runtime abstraction is also explicit and valid: `desktop/lib/core/runtime_platform.dart` centralizes the cross-platform checks and WSL detection (`desktop/lib/core/runtime_platform.dart:7-27`).
   - The branch preserves the maintainer-flagged Windows behavior choice: Windows remains in the viewer-only path intentionally, rather than silently dropping the Windows check while adding WSL support. That is the right local interpretation of the original bug and does not reopen the blocker.

2. Blocker 2: Closed
   - The ported parsing path fixes the real issue: `argvTokens()` and `argvPrefix()` are token-based and lazy, with the tokenizer still honoring shell quoting and without scanning past a bare `--` boundary (`cli/src/lib/tmux.ts:74-99`).
   - `bypassPermissionActive()` and `permissionModeFromArgv()` now operate on exact token matches, not raw substring checks, and `resumeSessionId()` only accepts a value when it matches the engine’s id contract (`cli/src/lib/tmux.ts:946-1015`).
   - The missing interactive-shell probe machinery is restored and wired in `engineLaunch.ts`; availability checks are no longer silently failing because there is no probe definition (`cli/src/lib/engineLaunch.ts:1270-1413`).
   - This closes the original security issue: prompt text can no longer enable bypass mode or fabricate a resume id through a raw string match.

Security property check

- The security property still holds in the ported implementation: relayed prompt text must not enable bypass mode or invent a resume session id.
- Evidence: `bypassPermissionActive()` uses `argvTokens(args)` and then `permissionModeFromTokens()`, which performs exact token matching via `flagsInOrder()`; a prompt containing `--dangerously-skip-permissions` as prose still fails because it is not an exact token (`cli/src/lib/tmux.ts:946-988`, `cli/src/lib/tmux.spec.ts:492-506`).
- The quoted / `--` edge is also covered: a bare `--` stops scanning and prompt text after it is not treated as actual CLI arguments; `processEntrypoint()` explicitly stops on `--` and `-m` while peeling launcher prefix (`cli/src/lib/tmux.ts:113-145`). That matches the original concern and prevents prompt text from being treated as flags.
- `resumeSessionId()` follows the same principle: it matches only recognized flag forms and valid id patterns, and it is checked against `spec.id.test(value)` and never a substring search (`cli/src/lib/tmux.ts:990-1015`, `cli/src/lib/tmux.spec.ts:403-447`).

Quoted-resume-id adaptation

- This is a sound preservation of upstream behavior, not a security hole.
- The branch intentionally keeps the quoted-resume case non-binding; the comment in the issue says this is the upstream record and the regression was explicitly covered. That is consistent with the design in `resumeSessionId()`: it reads only exact tokenized values, not an unconstrained quoted string that may appear in a shell prompt or wrapper. The branch is therefore preserving the upstream parser semantics rather than broadening them.
- In other words, this is not “accepting a synthetic resume id from prompt text”; it is intentionally mirroring the engine’s actual CLI contract. The test evidence in `cli/src/lib/processEvidence.spec.ts:73-84` and `cli/src/lib/tmux.spec.ts:432-447` supports that conservative choice.

Three `.exe` stand-off tests

- Leaving the three `.exe` cases red is the right call for this branch, not a weakening of the gate.
- The issue summary is consistent with the repo code: the capability gate is intentionally conservative and rejects a lone `<engine>.exe --version` as a non-usable capability probe. The repository’s own tests record that exact behavior (`cli/src/lib/tmux.spec.ts:196-211` and the issue point that upstream scores that form as 0 for any engine).
- The branch does not “accept `.exe` by default” in the capability probe; it simply avoids weakening the gate to make the tests green. That is the correct trade-off for a compatibility gate whose purpose is to avoid false positives.
- In practical terms, this is a contract choice in the upstream engine detection layer, not a bug in the re-review. If maintainer intent changes, the contract and tests should be updated together, rather than weakening the signal.

Removed assertion in `engineLaunch.spec.ts`

- This is a legitimate union-artifact repair, not a test weakened just to pass.
- The removed assertion was asserting `installing for this user` in a scenario where no install actually ran. The install string is emitted only under the npm-global install branch in `installIfMissingScript()` (`cli/src/lib/engineLaunch.ts:1232-1233`), and the spec scenario in question is not exercising that branch. The test was stale and inconsistent with the actual runtime path.
- The remaining behavior assertions in the same spec still cover the intended launch logic and do not materially weaken the test contract (`cli/src/lib/engineLaunch.spec.ts:1230-1254`).

New breakage / remaining inconsistencies

- I did not find a new blocker in the ported fix set.
- The only issue that remains is a verification gap: the code is solid on the repo’s Linux evidence, but a real Windows or WSL2 machine is still needed to confirm the exact desktop/WSL behavior and the `*.exe` / interactive-shell cases on native Windows rather than emulated Linux behavior.

Blockers

- None.

Should-fix

- Real Windows smoke test for `RuntimePlatform.isWindows` vs `isWsl` behavior in the desktop app (`desktop/lib/core/viewer_mode.dart`, `desktop/lib/core/runtime_platform.dart`). This is a validation item, not a blocker.
- Real-machine confirmation of the `.exe` / capability probe contract in native Windows/WSL2 shells (`cli/src/lib/engineLaunch.ts`, `cli/src/lib/tmux.ts`).

Nits

- None material enough to block the draft.

What still needs a real Windows machine, ordered by risk

1. Desktop viewer-mode semantics on actual Windows versus WSLg: ensure the explicit `isWindows` path is correct and does not regress the WSL2 case.
2. Native `.exe` capability detection and install-availability probes in a Windows shell: `claude.exe` / `codex.exe` and the path/flag contracts are the main remaining compatibility risk.
3. End-to-end launch and resume behavior for Windows/WSL2 sessions, especially the resume-id and permission-flag parsing under the real shell environment.

Conclusion

- The original two blockers are effectively closed by the branch changes reviewed here.
- The security property is preserved: prompt text still cannot trigger bypass mode or fabricate a resume id.
- The quoted-resume exception is a deliberate compatibility choice, not a hole.
- The remaining `.exe` red tests are a deliberate stand-off against the capability gate, not an accidental weakening.
- The removed assertion is a valid fix to a stale test, not a weakened assertion.
- I would keep the upstream draft live for maintainer review; no new blocker emerges from the fixes reviewed.
