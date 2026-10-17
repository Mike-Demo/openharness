Verdict: Don't file — the rebase drops the upstream Windows viewer guard and leaves the security-critical tmux/engine fixes unported, so the branch is not safe to merge as-is.

Blockers

- File: desktop/lib/core/viewer_mode.dart:1-18
  - What is wrong: this file is a direct compile failure and it also reverses the upstream Windows behavior.
  - Evidence: the rebase replaced the upstream guard with `Platform.isIOS || Platform.isAndroid` and removed the `RuntimePlatform.isWindows` case, but the file imports only `runtime_platform.dart` and never imports `dart:io`. In Dart, `Platform` is unresolved here, so the build will not compile. The supporting runtime check is still present in `desktop/lib/core/runtime_platform.dart:7-35` as `RuntimePlatform.isWindows`, which is the API the rest of the codebase uses. The current branch is therefore not just a policy change: it is a broken build and a behavior reversal.
  - Consequence: the app is now allowed to run in native Windows hosting mode instead of the viewer-only path that upstream intentionally enforced. That breaks the architecture contract: Windows does not run Harness natively; it runs the CLI inside WSL2, and the app should stay in the relay/viewer path unless the user explicitly forces viewer mode.

- File: cli/src/lib/engineLaunch.ts (availabilityScript / npmRuntimePrelude) and cli/src/lib/tmux.ts (basename / repairMangledRows / repairInteropRowFromCmdline)
  - What is wrong: the rebase does not carry the upstream security-hardening hunk around interactive-shell probing and tmux argv parsing. The branch has a partial WSL interop repair, but it still does not implement the upstream contract that prompt text and relayed argv fragments must never be treated as authoritative bypass/resume input.
  - Evidence: the tests added upstream in `cli/src/lib/engineLaunch.spec.ts` and `cli/src/lib/tmux.spec.ts` assert that `--` terminators, exact-token matches, `.exe` engine signatures, and escape-aware argv tokenization are required. The skipped hunk specifically covers the security property that a relayed prompt string must not enable bypass mode or synthesize a resume session id. This is not a cosmetic mismatch: it is a privilege boundary. The branch still fails the spec that distinguishes shell text from actual argv.
  - Consequence: a prompt or title text relayed by tmux or an interop layer can be mistaken for a live CLI invocation and trigger bypass or resume logic. In the worst case that yields a false `--resume` or bypass permission state, which is a security bug.

Should-fix

- File: desktop/lib/ws/local_cli_discovery.dart and desktop/lib/core/backend_path.dart
  - What is wrong: the WSL/Windows path logic is directionally right but still not robust enough for a real Windows host without a real Windows machine to validate it.
  - Evidence: the branch adds `LocalMachineIdentity.wslSelected`, `wslComputerId`, `BackendPath.toBackend()`, and WSL distro-aware logic, but the underlying contract is still fragile: a user-selected distro with Unicode names, a different distro root, or a project folder created without shell participation can still be misclassified as a valid backend path. The logic is specific to the WSL mount model (`/mnt/<drive>`, `\\wsl.localhost\<distro>`, etc.) and has obvious failure modes if the host path is not normalized before the CLI sees it.
  - Consequence: this is a strong candidate for silent misrouting or path failures in real Windows installs, especially where the distro name is non-ASCII or the project folder is created from native Windows tooling rather than the WSL shell. The bug is not necessarily a compile error, but it is operationally critical and should be fixed before shipping Windows hosting.

- File: .github/workflows/windows-desktop-checks.yml
  - What is wrong: the workflow is mechanically correct but is still a manual-only validation gate, not a real enforcement path.
  - Evidence: the workflow is `workflow_dispatch` + `workflow_call`, uses `windows-latest`, `pwsh`, resolves the Flutter pin from `.github/workflows/release-desktop.yml`, and invokes the repo-local `./.github/actions/desktop-flutter` action, which matches the repo’s stated pattern for heavy Windows builds. The problem is not syntax; it is that a manual-only workflow is a signal check, not a guardrail. If maintainers do not start it, the Windows path can regress without CI coverage.
  - Consequence: this is acceptable under the repo’s heavy-workflow rules, but it should be treated as a validation aid rather than an automatic gate. The fix is not code; it is operational discipline.

Nits

- File: desktop/lib/core/viewer_mode.dart and desktop/lib/core/runtime_platform.dart
  - This rebase should preserve the upstream viewer contract exactly. The branch’s direct use of `Platform.isIOS`/`Platform.isAndroid` in a file that never imports `dart:io` is an obvious rebase artifact and a sign that the hand-merge was not fully validated. It is not just a refactor; it is a missed compile-time invariant.

- File: .github/workflows/windows-desktop-checks.yml
  - Acceptable heavy-workflow pattern, but it still needs a real Windows runner for the final word. This is a manual validation workflow, and the repo's own guidance calls for manual-only heavy workflows precisely because the real Windows environment is not reproducible in Linux CI.

Security finding: tmux bypass/resume tests

Severity: High

- Files: cli/src/lib/tmux.ts, cli/src/lib/tmux.spec.ts, cli/src/lib/engineLaunch.ts, cli/src/lib/engineLaunch.spec.ts
- The upstream tests encode the hard security property: a relayed prompt string must not enable bypass mode or fabricate a resume session id. The tests are the right contract. `bypassPermissionActive()` and `resumeSessionId()` must ignore prompt text and only accept exact argv tokens, with proper `--` handling and `.exe` signatures.
- The rebase skipped the upstream rewrite and the branch still fails the spec. The dangerous case is exactly what the tests cover: a malicious or compromised prompt can appear to contain `--dangerously-skip-permissions`, `--resume`, or a session id string, and the daemon can mistakenly interpret that as a live CLI invocation. That would permit an attacker to bypass approval gating or falsely claim a resumed session.
- This is not a speculative “maybe” issue. The test names and comments in `cli/src/lib/tmux.spec.ts` are explicit: exact-token matching, no substring matches, no prompt-text false positives, and `--` terminator handling are required. The current implementation does not meet that contract.

Verification gaps that need a Windows machine

1. WSL distro selection and discovery: real `wsl.exe` output, distro enumeration, Unicode distro names, and multi-distro selection in `desktop/lib/ws/local_cli_discovery.dart` and `desktop/lib/core/wsl_runtime.dart`.
2. Windows↔WSL path translation and project creation: actual `C:\...` / `\\wsl.localhost\...` conversions, `BackendPath.toBackend()`, and creation of project folders without a shell on a real host.
3. Daemon loopback discovery from the native desktop: verify that the app can detect a daemon bound to loopback while the selected CLI runs in WSL2, and that the app stays consistent with the backend identity model.
4. Native Windows launch and environment provisioning: confirm `harness start` / install flows work from a real Windows 11 host with WSL2 enabled and without any Linux shell assumptions.
5. Packaging and release path: run `desktop/scripts/build-windows-release.sh` and a real Windows release build, not just a source review, to ensure the packaging assumptions are valid.
6. Manual CI smoke test: start `.github/workflows/windows-desktop-checks.yml` on `windows-latest` once and verify it passes in a real environment; the existing workflow is useful but not a substitute for a host-level check.
