# Third-party notices

Code in this repository adapted from other projects, outside the components that keep their own notices
(`tui/THIRD_PARTY_NOTICES.md`, `desktop/third_party/`, `mobile/third_party/`, `store/`). Each adapted file
also names its source in a header comment.

## Orca

The Harness CLI's Windows process control is adapted from Orca (https://github.com/stablyai/orca):

- `cli/src/lib/windows/treeKill.ts`, from `src/main/windows-process-tree-kill.ts` (the `taskkill /T`
  tree kill and its bounds) and `src/main/windows-pty-root-identity.ts` (checking a pid before killing
  its tree).

Orca carries this notice:

```
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
