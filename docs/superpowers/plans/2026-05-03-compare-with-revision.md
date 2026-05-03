# Compare with Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Explorer context-menu action that lets the user compare any file or folder in the workspace against the same path at a chosen Git revision (branch, tag, or commit), with live working-tree diffs for files and a preview-mode browsing experience for folders.

**Architecture:** A new `intelliGit.compareWithRevision` command, registered on `explorer/context`, opens a VS Code-native QuickPick (sectioned: Local branches → Remote branches → Tags) augmented with a dynamic commit-SHA lookup. After the user picks a ref, files are diffed in `vscode.diff` with the on-disk working-tree URI on the right; folders are surfaced in the existing `CommitFilesTreeProvider` (new `'workingTreeCompare'` mode), where clicking files opens diffs in **preview** mode so the same tab is reused as the user browses.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode.window.createQuickPick`, `vscode.diff`, `vscode.workspace.fs`), Node `child_process` (existing `GitService.runGit`), Node `node:test` runner.

Spec: `docs/superpowers/specs/2026-05-03-compare-with-revision-design.md`

---

## File Structure

**New files**
- `src/views/revisionPicker.ts` — exports `pickRevisionToCompare(...)`, plus pure helpers `buildRevisionPickerItems(branches, tags)` and `isLikelyShaPrefix(input)` for unit testing.
- `src/test/revisionPicker.test.ts` — unit tests for the pure helpers.
- `src/test/workingTreeDiff.test.ts` — fixture-repo integration test for the new GitService methods + the `parseNameStatusZ` parser.

**Modified files**
- `src/services/gitParsing.ts` — add `parseNameStatusZ(stdout: string): FileChange[]` exported pure function.
- `src/services/gitService.ts` — add `getFilesChangedBetweenWorkingTreeAndRef`, `resolveRevisionToCommit`, plus a `WorkingTreeFileChange` type re-exported from `types.ts`.
- `src/types.ts` — add `WorkingTreeFileChange` interface (extends `CommitFileChange` with `untracked: boolean`).
- `src/providers/commitFilesTreeProvider.ts` — add new tree-item class `WorkingTreeCompareFileTreeItem`, extend `ActiveTreeState` with `'workingTreeCompare'` variant, add `showWorkingTreeComparison` method, route folder-children build through a new `buildWorkingTreeCompareTree` helper.
- `src/editor/editorOrchestrator.ts` — add `openCompareWithRevisionForFile`, `openCompareWithRevisionForFolder`, `openWorkingTreeFileDiff` methods.
- `src/commands/commandController.ts` — register `intelliGit.compareWithRevision` and `intelliGit.workingTreeCompare.openFileDiff`. Pass `commitFilesProvider` (already injected) into the new orchestrator methods.
- `src/extension.ts` — wire new orchestrator dependency only if the `commandController` constructor signature changes; otherwise no change.
- `package.json` — new command contribution, new `explorer/context` entry, `commandPalette` hide entry.
- `README.md` — feature list + Explorer context menu section.
- `CHANGELOG.md` — entry under unreleased / next version.

---

## Conventions & shared types (used by every task)

```typescript
// src/types.ts addition
export interface WorkingTreeFileChange {
  readonly status: string;       // 'M' | 'A' | 'D' | 'R' | 'C'
  readonly path: string;          // repo-relative (POSIX-style "/")
  readonly untracked: boolean;    // true if discovered via ls-files --others
}
```

```typescript
// src/views/revisionPicker.ts public surface
export type RevisionKind = 'branch' | 'remote' | 'tag' | 'commit';

export interface RevisionSelection {
  readonly ref: string;        // exact ref to pass to git (branch name, tag name, or full SHA)
  readonly label: string;      // human label to show in editor titles (e.g., "main", "v1.2.0", "9f3a4d8")
  readonly kind: RevisionKind;
}

export interface ResolvedCommitMeta {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
}

export function pickRevisionToCompare(
  git: GitService,
  branches: readonly BranchRef[],
  tags: readonly TagRef[]
): Promise<RevisionSelection | undefined>;
```

The diff convention everywhere: **left = revision X, right = working tree**.

---

## Task 0: Add `parseNameStatusZ` to `gitParsing.ts`

**Goal:** Centralize parsing of `git diff --name-status -z` output into a pure function with tests, so the new GitService methods can use it.

**Files:**
- Modify: `src/services/gitParsing.ts`
- Test: `src/test/workingTreeDiff.test.ts` (new file, parser test only — repo integration added in Task 1)

**Acceptance Criteria:**
- [ ] `parseNameStatusZ` parses NUL-separated `--name-status -z` output into `FileChange[]`.
- [ ] Handles `M`, `A`, `D` (one path), and `R<score>` / `C<score>` (two paths — old<NUL>new). For renames/copies, returns the **new** path with status `R` or `C`.
- [ ] Trailing NUL is tolerated; empty input → `[]`.
- [ ] Test passes.

**Verify:** `npm run compile && node --test dist/test/workingTreeDiff.test.js` → all assertions pass.

**Steps:**

- [ ] **Step 1: Write the failing tests**

Create `src/test/workingTreeDiff.test.ts` with:

```typescript
import * as assert from 'assert';
import { describe, it } from 'node:test';
import { parseNameStatusZ } from '../services/gitParsing';

describe('parseNameStatusZ', () => {
  it('returns [] for empty input', () => {
    assert.deepStrictEqual(parseNameStatusZ(''), []);
  });

  it('parses simple modify/add/delete', () => {
    const raw = 'M\0src/a.ts\0A\0src/b.ts\0D\0src/c.ts\0';
    assert.deepStrictEqual(parseNameStatusZ(raw), [
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'src/b.ts' },
      { status: 'D', path: 'src/c.ts' }
    ]);
  });

  it('parses rename and copy with two paths, keeping the new path', () => {
    const raw = 'R100\0old/foo.ts\0new/foo.ts\0C75\0src/x.ts\0src/y.ts\0';
    assert.deepStrictEqual(parseNameStatusZ(raw), [
      { status: 'R', path: 'new/foo.ts' },
      { status: 'C', path: 'src/y.ts' }
    ]);
  });

  it('tolerates missing trailing NUL', () => {
    const raw = 'M\0only.ts';
    assert.deepStrictEqual(parseNameStatusZ(raw), [{ status: 'M', path: 'only.ts' }]);
  });
});
```

- [ ] **Step 2: Run test, observe failure**

```bash
npm run compile
node --test dist/test/workingTreeDiff.test.js
```

Expected: FAIL with "parseNameStatusZ is not a function" or similar import error.

- [ ] **Step 3: Implement `parseNameStatusZ` in `src/services/gitParsing.ts`**

Append the function (use the existing file's import / export style). Use `mcp__serena__insert_after_symbol` targeting the last existing top-level symbol in the file to add:

```typescript
export interface NameStatusEntry {
  readonly status: string;
  readonly path: string;
}

export function parseNameStatusZ(stdout: string): NameStatusEntry[] {
  if (!stdout) {
    return [];
  }

  const tokens = stdout.split('\0').filter((token) => token.length > 0);
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < tokens.length) {
    const rawStatus = tokens[i];
    const head = rawStatus.charAt(0).toUpperCase();
    if (head === 'R' || head === 'C') {
      // R<score>\0<old>\0<new>
      const newPath = tokens[i + 2];
      if (newPath) {
        entries.push({ status: head, path: newPath });
      }
      i += 3;
      continue;
    }
    const pathToken = tokens[i + 1];
    if (pathToken) {
      entries.push({ status: head, path: pathToken });
    }
    i += 2;
  }
  return entries;
}
```

- [ ] **Step 4: Re-run tests, observe pass**

```bash
npm run compile
node --test dist/test/workingTreeDiff.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/gitParsing.ts src/test/workingTreeDiff.test.ts
git commit -m "$(cat <<'EOF'
feat(git): add parseNameStatusZ helper for diff -z output

Centralizes parsing of `git diff --name-status -z` output so subsequent
working-tree comparison code can rely on a single tested parser. Renames
and copies surface only the new path.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1: GitService — `getFilesChangedBetweenWorkingTreeAndRef` & `resolveRevisionToCommit`

**Goal:** Add the two service methods needed for folder-mode list assembly and picker SHA resolution.

**Files:**
- Modify: `src/types.ts` (add `WorkingTreeFileChange`)
- Modify: `src/services/gitService.ts` (add two methods)
- Modify: `src/test/workingTreeDiff.test.ts` (add fixture-repo integration tests)

**Acceptance Criteria:**
- [ ] `getFilesChangedBetweenWorkingTreeAndRef(ref, scopePath?)` returns `WorkingTreeFileChange[]`:
  - Tracked changes pulled from `git diff --name-status -z <ref> [-- <scope>]`.
  - Untracked files (per `.gitignore`) appended as `{ status: 'A', untracked: true }` via `git ls-files --others --exclude-standard -z [-- <scope>]`.
  - When `scopePath` is `''` or `'.'`, the whole repo is scanned.
  - Paths are returned in POSIX form (forward slashes).
- [ ] `resolveRevisionToCommit(input)` returns `ResolvedCommitMeta | undefined`:
  - Calls `git rev-parse --verify <input>^{commit}` then `git log -1 --format=…<sha>`.
  - Returns `undefined` (does NOT throw) on any git failure.
- [ ] Tests pass against a real fixture repo created in a temp directory.

**Verify:** `npm run compile && node --test dist/test/workingTreeDiff.test.js` → all assertions pass.

**Steps:**

- [ ] **Step 1: Add the type to `src/types.ts`**

Insert after the existing `CommitFileChange` interface using `mcp__serena__insert_after_symbol`:

```typescript
export interface WorkingTreeFileChange {
  readonly status: string;
  readonly path: string;
  readonly untracked: boolean;
}
```

- [ ] **Step 2: Add failing integration tests to `src/test/workingTreeDiff.test.ts`**

Append below the existing `parseNameStatusZ` describe block:

```typescript
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitService } from '../services/gitService';
import { Logger } from '../logger';
import * as vscode from 'vscode';

function makeFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'igit-cmp-'));
  const run = (args: string[]) => cp.execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'one\n');
  fs.writeFileSync(path.join(dir, 'src/b.ts'), 'one\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  // Working-tree changes vs HEAD:
  fs.writeFileSync(path.join(dir, 'src/a.ts'), 'two\n');                  // M
  fs.unlinkSync(path.join(dir, 'src/b.ts'));                              // D
  fs.writeFileSync(path.join(dir, 'src/c.ts'), 'new\n');                  // untracked → A
  fs.writeFileSync(path.join(dir, 'docs.md'), 'doc\n');                   // untracked outside src
  return dir;
}

function makeGitService(repoRoot: string): GitService {
  const ctx = { subscriptions: [] as vscode.Disposable[] } as unknown as vscode.ExtensionContext;
  const cfg = {
    get: <T>(_key: string, def: T): T => def
  } as unknown as vscode.WorkspaceConfiguration;
  const logger = new Logger('test');
  const svc = new GitService(ctx, logger, cfg);
  // Force the gitRoot cache so the service does not call `git rev-parse` for it.
  (svc as unknown as { _gitRootCache: string })._gitRootCache = repoRoot;
  return svc;
}

describe('GitService.getFilesChangedBetweenWorkingTreeAndRef', () => {
  it('lists tracked changes plus untracked files for the whole repo', async () => {
    const dir = makeFixtureRepo();
    const svc = makeGitService(dir);
    const result = await svc.getFilesChangedBetweenWorkingTreeAndRef('HEAD');
    const sorted = [...result].sort((a, b) => a.path.localeCompare(b.path));
    assert.deepStrictEqual(sorted, [
      { status: 'A', path: 'docs.md', untracked: true },
      { status: 'A', path: 'src/c.ts', untracked: true },
      { status: 'D', path: 'src/b.ts', untracked: false },
      { status: 'M', path: 'src/a.ts', untracked: false }
    ]);
  });

  it('respects scopePath for both tracked and untracked', async () => {
    const dir = makeFixtureRepo();
    const svc = makeGitService(dir);
    const result = await svc.getFilesChangedBetweenWorkingTreeAndRef('HEAD', 'src');
    const sorted = [...result].sort((a, b) => a.path.localeCompare(b.path));
    assert.deepStrictEqual(sorted, [
      { status: 'A', path: 'src/c.ts', untracked: true },
      { status: 'D', path: 'src/b.ts', untracked: false },
      { status: 'M', path: 'src/a.ts', untracked: false }
    ]);
  });
});

describe('GitService.resolveRevisionToCommit', () => {
  it('resolves a real short SHA prefix to commit metadata', async () => {
    const dir = makeFixtureRepo();
    const svc = makeGitService(dir);
    const headSha = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    const meta = await svc.resolveRevisionToCommit(headSha.slice(0, 7));
    assert.ok(meta);
    assert.strictEqual(meta!.sha, headSha);
    assert.strictEqual(meta!.subject, 'init');
  });

  it('returns undefined for a SHA that does not exist', async () => {
    const dir = makeFixtureRepo();
    const svc = makeGitService(dir);
    const meta = await svc.resolveRevisionToCommit('deadbeef');
    assert.strictEqual(meta, undefined);
  });
});
```

- [ ] **Step 3: Run tests, observe failure**

```bash
npm run compile
node --test dist/test/workingTreeDiff.test.js
```

Expected: FAILS in the new describe blocks with "getFilesChangedBetweenWorkingTreeAndRef is not a function" / "resolveRevisionToCommit is not a function".

- [ ] **Step 4: Implement the two methods on `GitService`**

Use `mcp__serena__insert_after_symbol` targeting `GitService/getFilesChangedBetween` to add the methods inside the class:

```typescript
async getFilesChangedBetweenWorkingTreeAndRef(
  ref: string,
  scopePath?: string
): Promise<WorkingTreeFileChange[]> {
  const scope = scopePath && scopePath !== '.' ? scopePath : undefined;

  const trackedArgs = ['diff', '--name-status', '-z', ref];
  if (scope) {
    trackedArgs.push('--', scope);
  }
  const trackedResult = await this.runGit(trackedArgs);
  const tracked = parseNameStatusZ(trackedResult.stdout).map<WorkingTreeFileChange>((entry) => ({
    status: entry.status,
    path: entry.path,
    untracked: false
  }));

  const untrackedArgs = ['ls-files', '--others', '--exclude-standard', '-z'];
  if (scope) {
    untrackedArgs.push('--', scope);
  }
  const untrackedResult = await this.runGit(untrackedArgs);
  const untracked = untrackedResult.stdout
    .split('\0')
    .map((token) => token.trim())
    .filter(Boolean)
    .map<WorkingTreeFileChange>((relativePath) => ({
      status: 'A',
      path: relativePath,
      untracked: true
    }));

  return [...tracked, ...untracked];
}

async resolveRevisionToCommit(input: string): Promise<ResolvedCommitMeta | undefined> {
  const candidate = input.trim();
  if (!candidate) {
    return undefined;
  }

  try {
    const verify = await this.runGit(['rev-parse', '--verify', `${candidate}^{commit}`]);
    const sha = verify.stdout.trim();
    if (!sha) {
      return undefined;
    }
    const log = await this.runGit([
      'log',
      '-1',
      `--format=%H${FIELD_SEPARATOR}%s${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI`,
      sha
    ]);
    const [resolvedSha, subject, author, date] = log.stdout.split(FIELD_SEPARATOR);
    return {
      sha: (resolvedSha ?? sha).trim(),
      subject: (subject ?? '').trim(),
      author: (author ?? '').trim(),
      date: (date ?? '').trim()
    };
  } catch {
    return undefined;
  }
}
```

Then add the import and re-export at the top of `gitService.ts`:

```typescript
import { parseNameStatusZ } from './gitParsing';
import { WorkingTreeFileChange } from '../types';
```

And add the `ResolvedCommitMeta` interface either inline at the top of `gitService.ts` (preferred for locality) or in `types.ts`. Place it directly above the `GitService` class declaration:

```typescript
export interface ResolvedCommitMeta {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
}
```

- [ ] **Step 5: Re-run tests, observe pass**

```bash
npm run compile
node --test dist/test/workingTreeDiff.test.js
```

Expected: All tests pass (parseNameStatusZ + the two new describe blocks).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/services/gitService.ts src/test/workingTreeDiff.test.ts
git commit -m "$(cat <<'EOF'
feat(git): add working-tree-vs-ref diff and revision resolver

`getFilesChangedBetweenWorkingTreeAndRef` lists tracked diffs (parsed
via parseNameStatusZ) plus untracked files (ls-files --others) for an
optional folder scope. `resolveRevisionToCommit` resolves any branch,
tag, or SHA prefix to a commit with metadata, returning undefined on
failure rather than throwing — so the picker can probe inputs cheaply.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Revision picker (`src/views/revisionPicker.ts`)

**Goal:** A QuickPick that mirrors VS Code's "Select branch or tag to checkout" UI (sectioned local/remote/tag) and dynamically resolves typed SHA prefixes into a selectable synthetic commit item.

**Files:**
- Create: `src/views/revisionPicker.ts`
- Create: `src/test/revisionPicker.test.ts`

**Acceptance Criteria:**
- [ ] `isLikelyShaPrefix(input)` returns `true` only for `^[0-9a-f]{4,40}$`.
- [ ] `buildRevisionPickerItems(branches, tags)` returns a flat array of `vscode.QuickPickItem & { revision?: RevisionSelection }` containing:
  - Separator labelled "Local branches" followed by all `type === 'local'` branches.
  - Separator labelled "Remote branches" followed by all `type === 'remote'` branches.
  - Separator labelled "Tags" followed by all tags.
  - Each ref item has a `$(git-branch)` / `$(cloud)` / `$(tag)` icon prefix in the label, an upstream/short-SHA description, and the `revision` payload.
  - Sections that would be empty are omitted entirely (no orphan separator).
- [ ] `pickRevisionToCompare(git, branches, tags)` shows the QuickPick, debounces SHA-prefix inputs by 150ms, calls `git.resolveRevisionToCommit`, and prepends a `$(git-commit)` synthetic item to the list while typing matches a SHA. Selection of the synthetic item resolves to `{ ref: sha, label: short(sha), kind: 'commit' }`.
- [ ] Pure-helper tests pass.

**Verify:** `npm run compile && node --test dist/test/revisionPicker.test.js` → assertions pass.

**Steps:**

- [ ] **Step 1: Write failing tests in `src/test/revisionPicker.test.ts`**

```typescript
import * as assert from 'assert';
import { describe, it } from 'node:test';
import { buildRevisionPickerItems, isLikelyShaPrefix } from '../views/revisionPicker';
import { BranchRef, TagRef } from '../types';

describe('isLikelyShaPrefix', () => {
  it('accepts 4-40 hex characters', () => {
    assert.strictEqual(isLikelyShaPrefix('a1b2'), true);
    assert.strictEqual(isLikelyShaPrefix('9f3a4d8'), true);
    assert.strictEqual(isLikelyShaPrefix('1234567890abcdef1234567890abcdef12345678'), true);
  });

  it('rejects too short, too long, or non-hex', () => {
    assert.strictEqual(isLikelyShaPrefix('abc'), false);
    assert.strictEqual(isLikelyShaPrefix('12345678901234567890123456789012345678901'), false);
    assert.strictEqual(isLikelyShaPrefix('main'), false);
    assert.strictEqual(isLikelyShaPrefix('abcXYZ'), false);
    assert.strictEqual(isLikelyShaPrefix(''), false);
  });
});

describe('buildRevisionPickerItems', () => {
  const branches: BranchRef[] = [
    { name: 'main',          shortName: 'main',    fullName: 'refs/heads/main',          type: 'local',  ahead: 0, behind: 0, current: true,  upstream: 'origin/main' } as BranchRef,
    { name: 'feature/x',     shortName: 'feature/x', fullName: 'refs/heads/feature/x',   type: 'local',  ahead: 1, behind: 0, current: false } as BranchRef,
    { name: 'origin/main',   shortName: 'main',    fullName: 'refs/remotes/origin/main', type: 'remote', remoteName: 'origin', ahead: 0, behind: 0, current: false } as BranchRef
  ];

  const tags: TagRef[] = [
    { name: 'v1.0.0', fullName: 'refs/tags/v1.0.0', sha: 'a1b2c3d4e5f6' } as TagRef
  ];

  it('emits local, remote, tag sections in order with correct icons and payloads', () => {
    const items = buildRevisionPickerItems(branches, tags);
    const labels = items.map((i) => i.label);
    assert.deepStrictEqual(labels, [
      'Local branches',
      '$(git-branch) main',
      '$(git-branch) feature/x',
      'Remote branches',
      '$(cloud) origin/main',
      'Tags',
      '$(tag) v1.0.0'
    ]);

    const tagItem = items.find((i) => i.label === '$(tag) v1.0.0');
    assert.ok(tagItem?.revision);
    assert.strictEqual(tagItem!.revision!.ref, 'v1.0.0');
    assert.strictEqual(tagItem!.revision!.kind, 'tag');
  });

  it('omits empty sections', () => {
    const items = buildRevisionPickerItems([branches[0]], []);
    assert.deepStrictEqual(items.map((i) => i.label), ['Local branches', '$(git-branch) main']);
  });
});
```

- [ ] **Step 2: Run tests, observe failure**

```bash
npm run compile
node --test dist/test/revisionPicker.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/views/revisionPicker.ts`**

```typescript
import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { BranchRef, TagRef } from '../types';

export type RevisionKind = 'branch' | 'remote' | 'tag' | 'commit';

export interface RevisionSelection {
  readonly ref: string;
  readonly label: string;
  readonly kind: RevisionKind;
}

interface RevisionPickItem extends vscode.QuickPickItem {
  revision?: RevisionSelection;
}

const SHA_PATTERN = /^[0-9a-f]{4,40}$/;

export function isLikelyShaPrefix(input: string): boolean {
  return SHA_PATTERN.test(input);
}

export function buildRevisionPickerItems(
  branches: readonly BranchRef[],
  tags: readonly TagRef[]
): RevisionPickItem[] {
  const items: RevisionPickItem[] = [];

  const local = branches.filter((b) => b.type === 'local');
  const remote = branches.filter((b) => b.type === 'remote');

  if (local.length > 0) {
    items.push({ label: 'Local branches', kind: vscode.QuickPickItemKind.Separator });
    for (const branch of local) {
      items.push({
        label: `$(git-branch) ${branch.name}`,
        description: branch.upstream ? `→ ${branch.upstream}` : '',
        revision: { ref: branch.name, label: branch.name, kind: 'branch' }
      });
    }
  }

  if (remote.length > 0) {
    items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator });
    for (const branch of remote) {
      items.push({
        label: `$(cloud) ${branch.name}`,
        description: branch.remoteName ?? '',
        revision: { ref: branch.name, label: branch.name, kind: 'remote' }
      });
    }
  }

  if (tags.length > 0) {
    items.push({ label: 'Tags', kind: vscode.QuickPickItemKind.Separator });
    for (const tag of tags) {
      items.push({
        label: `$(tag) ${tag.name}`,
        description: tag.sha ? tag.sha.slice(0, 7) : '',
        revision: { ref: tag.name, label: tag.name, kind: 'tag' }
      });
    }
  }

  return items;
}

export async function pickRevisionToCompare(
  git: GitService,
  branches: readonly BranchRef[],
  tags: readonly TagRef[]
): Promise<RevisionSelection | undefined> {
  const baseItems = buildRevisionPickerItems(branches, tags);

  return new Promise<RevisionSelection | undefined>((resolve) => {
    const picker = vscode.window.createQuickPick<RevisionPickItem>();
    picker.title = 'Compare with Revision';
    picker.placeholder = 'Select a branch or tag — or type a commit SHA';
    picker.matchOnDescription = true;
    picker.items = baseItems;

    let lookupSeq = 0;
    let lookupTimer: NodeJS.Timeout | undefined;
    let syntheticCommit: RevisionPickItem | undefined;

    const refreshItems = () => {
      picker.items = syntheticCommit ? [syntheticCommit, ...baseItems] : baseItems;
    };

    const clearSynthetic = () => {
      if (syntheticCommit) {
        syntheticCommit = undefined;
        refreshItems();
      }
    };

    picker.onDidChangeValue((value) => {
      const trimmed = value.trim();
      if (lookupTimer) {
        clearTimeout(lookupTimer);
        lookupTimer = undefined;
      }
      if (!isLikelyShaPrefix(trimmed)) {
        clearSynthetic();
        picker.busy = false;
        return;
      }

      const seq = ++lookupSeq;
      picker.busy = true;
      lookupTimer = setTimeout(async () => {
        const meta = await git.resolveRevisionToCommit(trimmed);
        if (seq !== lookupSeq) {
          return; // stale
        }
        picker.busy = false;
        if (!meta) {
          clearSynthetic();
          return;
        }
        const short = meta.sha.slice(0, 7);
        syntheticCommit = {
          label: `$(git-commit) ${short}`,
          description: meta.subject,
          detail: `${meta.author} · ${meta.date}`,
          revision: { ref: meta.sha, label: short, kind: 'commit' }
        };
        refreshItems();
      }, 150);
    });

    picker.onDidAccept(() => {
      const [picked] = picker.selectedItems;
      picker.hide();
      resolve(picked?.revision);
    });

    picker.onDidHide(() => {
      if (lookupTimer) {
        clearTimeout(lookupTimer);
      }
      picker.dispose();
      // resolve(undefined) is a no-op if onDidAccept already resolved.
      resolve(undefined);
    });

    picker.show();
  });
}
```

- [ ] **Step 4: Re-run tests, observe pass**

```bash
npm run compile
node --test dist/test/revisionPicker.test.js
```

Expected: PASS.

- [ ] **Step 5: Lint**

```bash
npm run lint
```

Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/views/revisionPicker.ts src/test/revisionPicker.test.ts
git commit -m "$(cat <<'EOF'
feat(views): add revision picker for compare-with-revision

Adds a sectioned QuickPick (local / remote / tag) with type-icon
prefixes, matching VS Code's checkout-picker UX. Typing a SHA prefix
debounces a rev-parse lookup and prepends a synthetic commit entry
while the input matches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `CommitFilesTreeProvider` — `'workingTreeCompare'` mode

**Goal:** Extend the provider with a third mode that lists working-tree-vs-ref differences scoped to a folder, with file items that dispatch to a new preview-mode diff command.

**Files:**
- Modify: `src/providers/commitFilesTreeProvider.ts`

**Acceptance Criteria:**
- [ ] New exported class `WorkingTreeCompareFileTreeItem` carries `(ref, refLabel, filePath, status, untracked, workspaceRoot)`, sets `command` to `intelliGit.workingTreeCompare.openFileDiff` with the item as its argument, and shows an "Untracked" description when `untracked` is true (status badge otherwise).
- [ ] `ActiveTreeState` gains a `'workingTreeCompare'` variant: `{ mode: 'workingTreeCompare'; ref: string; refLabel: string; scopePath: string; files: WorkingTreeFileChange[] }`.
- [ ] New method `showWorkingTreeComparison({ ref, refLabel, scopePath, files })` sets the active state, fires the change emitter, sets `intelliGit.commitViewVisible = true`, sets `intelliGit.commitViewCanRevertSelected = false` and `intelliGit.commitViewCanCherryPickSelected = false`, then focuses the view.
- [ ] `getChildren` returns `WorkingTreeCompareFileTreeItem` leaves and `CommitFolderTreeItem` folders for the new mode (reuses `buildTree` via a new `buildWorkingTreeCompareTree` helper).
- [ ] `clear()` and the existing modes still work unchanged.

**Verify:** `npm run check-types && npm run compile && npm run lint` all pass; the existing test suite still passes.

**Steps:**

- [ ] **Step 1: Add the tree-item class and ActiveTreeState variant**

Use `mcp__serena__insert_after_symbol` targeting `RevisionFileTreeItem` to add:

```typescript
export class WorkingTreeCompareFileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ref: string,
    public readonly refLabel: string,
    public readonly filePath: string,
    public readonly status: string,
    public readonly untracked: boolean,
    workspaceRoot: string
  ) {
    const fileName = filePath.split('/').at(-1) ?? filePath;
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.id = `commitView:wtCompare:${ref}:${filePath}`;
    this.contextValue = 'workingTreeCompareFile';
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, filePath));
    this.description = untracked ? 'Untracked' : statusBadge(status).padStart(2, ' ');
    this.tooltip = `${filePath}\nWorking tree ↔ ${refLabel}\n${untracked ? 'Untracked' : statusTitle(status)}`;
    this.command = {
      title: 'Open Working-Tree Compare File Diff',
      command: 'intelliGit.workingTreeCompare.openFileDiff',
      arguments: [this]
    };
  }
}
```

Update `CommitViewNode` to include the new item:

```typescript
type CommitViewNode = CommitFileTreeItem | CommitFolderTreeItem | RevisionFileTreeItem | WorkingTreeCompareFileTreeItem;
```

Update `ActiveTreeState`:

```typescript
type ActiveTreeState =
  | { mode: 'commit'; sha: string; subject: string; files: CommitFileChange[]; canRevertSelected: boolean }
  | { mode: 'revision'; sha: string; files: TreeFileEntry[] }
  | { mode: 'workingTreeCompare'; ref: string; refLabel: string; scopePath: string; files: WorkingTreeFileChange[] };
```

Add the import for `WorkingTreeFileChange`:

```typescript
import { CommitFileChange, WorkingTreeFileChange } from '../types';
```

- [ ] **Step 2: Add `buildWorkingTreeCompareTree` helper**

Use `mcp__serena__insert_after_symbol` targeting `buildRevisionTree`:

```typescript
function buildWorkingTreeCompareTree(
  ref: string,
  refLabel: string,
  files: WorkingTreeFileChange[],
  basePath: string,
  workspaceRoot: string
): CommitViewNode[] {
  return buildTree(
    files.map((file) => ({ path: file.path, status: file.status, untracked: file.untracked })),
    basePath,
    workspaceRoot,
    (filePath, status, extra) =>
      new WorkingTreeCompareFileTreeItem(
        ref,
        refLabel,
        filePath,
        status ?? '',
        Boolean((extra as { untracked?: boolean } | undefined)?.untracked),
        workspaceRoot
      ),
    (folderPath, children) =>
      new CommitFolderTreeItem(`commitView:wtCompare:${ref}`, folderPath, children, workspaceRoot)
  );
}
```

- [ ] **Step 3: Extend `buildTree` to forward an `extra` payload**

Replace the `buildTree` function body with the version that carries through arbitrary per-entry extras. Use `mcp__serena__replace_symbol_body` on `buildTree`:

```typescript
function buildTree(
  files: TreeFileEntry[],
  basePath: string,
  workspaceRoot: string,
  toFileItem: (filePath: string, status?: string, extra?: Record<string, unknown>) => CommitFileTreeItem | RevisionFileTreeItem | WorkingTreeCompareFileTreeItem,
  toFolderItem: (folderPath: string, children: TreeFileEntry[]) => CommitFolderTreeItem
): CommitViewNode[] {
  const folders = new Map<string, TreeFileEntry[]>();
  const leaves: Array<CommitFileTreeItem | RevisionFileTreeItem | WorkingTreeCompareFileTreeItem> = [];

  for (const file of files) {
    const relative = basePath ? file.path.slice(basePath.length + 1) : file.path;
    const slashIdx = relative.indexOf('/');
    if (slashIdx === -1) {
      leaves.push(toFileItem(file.path, file.status, file as unknown as Record<string, unknown>));
      continue;
    }
    const segment = relative.slice(0, slashIdx);
    const childPath = basePath ? `${basePath}/${segment}` : segment;
    const list = folders.get(childPath) ?? [];
    list.push(file);
    folders.set(childPath, list);
  }

  const folderItems = [...folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folderPath, children]) => toFolderItem(folderPath, children));

  leaves.sort((a, b) => a.resourceUri?.path.localeCompare(b.resourceUri?.path ?? '') ?? 0);
  return [...folderItems, ...leaves];
}
```

Update the `TreeFileEntry` type to be permissive:

```typescript
type TreeFileEntry = { path: string; status?: string; untracked?: boolean };
```

- [ ] **Step 4: Wire the new mode into `getChildren`**

Use `mcp__serena__replace_symbol_body` on `CommitFilesTreeProvider/getChildren`:

```typescript
async getChildren(element?: CommitViewNode): Promise<CommitViewNode[]> {
  if (!this.activeState) {
    return [];
  }

  if (!element) {
    if (this.activeState.mode === 'commit') {
      return buildCommitTree(this.activeState.sha, this.activeState.files, '', this.git.rootPath);
    }
    if (this.activeState.mode === 'revision') {
      return buildRevisionTree(this.activeState.sha, this.activeState.files, '', this.git.rootPath);
    }
    return buildWorkingTreeCompareTree(
      this.activeState.ref,
      this.activeState.refLabel,
      this.activeState.files,
      this.activeState.scopePath,
      this.git.rootPath
    );
  }

  if (element instanceof CommitFolderTreeItem) {
    if (this.activeState.mode === 'commit') {
      return buildCommitTree(this.activeState.sha, element.children, element.folderPath, this.git.rootPath);
    }
    if (this.activeState.mode === 'revision') {
      return buildRevisionTree(this.activeState.sha, element.children, element.folderPath, this.git.rootPath);
    }
    return buildWorkingTreeCompareTree(
      this.activeState.ref,
      this.activeState.refLabel,
      element.children as WorkingTreeFileChange[],
      element.folderPath,
      this.git.rootPath
    );
  }

  return [];
}
```

- [ ] **Step 5: Add `showWorkingTreeComparison` method**

Use `mcp__serena__insert_after_symbol` targeting `CommitFilesTreeProvider/showRevision`:

```typescript
async showWorkingTreeComparison(args: {
  ref: string;
  refLabel: string;
  scopePath: string;
  files: WorkingTreeFileChange[];
}): Promise<void> {
  this.activeState = {
    mode: 'workingTreeCompare',
    ref: args.ref,
    refLabel: args.refLabel,
    scopePath: args.scopePath,
    files: args.files
  };
  this.emitter.fire();
  await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewVisible', true);
  await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanRevertSelected', false);
  await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanCherryPickSelected', false);
  await vscode.commands.executeCommand(`${CommitFilesTreeProviderViewId}.focus`);
}
```

- [ ] **Step 6: Verify build & existing tests**

```bash
npm run check-types
npm run compile
npm run lint
node --test dist/test/*.test.js
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/providers/commitFilesTreeProvider.ts
git commit -m "$(cat <<'EOF'
feat(commit-view): add workingTreeCompare mode for folder diffs

Introduces WorkingTreeCompareFileTreeItem and a third active-state
variant in CommitFilesTreeProvider. The new mode renders working-tree-
vs-ref differences scoped to a folder, marking untracked files
explicitly and dispatching clicks to a dedicated preview-diff command.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `EditorOrchestrator` — file & folder compare entry points

**Goal:** Add the orchestrator methods that wire the picker output to either a single diff editor (file) or the populated Commit Details view + first-file preview diff (folder).

**Files:**
- Modify: `src/editor/editorOrchestrator.ts`

**Acceptance Criteria:**
- [ ] `openWorkingTreeFileDiff(relativePath, ref, refLabel, opts)` opens `vscode.diff` with **left** = virtual `intelligit:` URI for `(ref, relativePath)` and **right** = `file://` URI of the on-disk file when it exists, falling back to a virtual URI with empty content when the file is deleted in the working tree. `opts` accepts `{ preview: boolean; status?: string }`.
- [ ] `openCompareWithRevisionForFile(relativePath, ref, refLabel)` calls the above with `preview: false`.
- [ ] `openCompareWithRevisionForFolder(folderRel, ref, refLabel)` fetches `getFilesChangedBetweenWorkingTreeAndRef`, returns silently after `showInformationMessage` when empty, otherwise calls `commitFilesView.showWorkingTreeComparison(...)` and opens the first file diff with `preview: true`.

**Verify:** `npm run check-types && npm run compile && npm run lint` all pass.

**Steps:**

- [ ] **Step 1: Update the constructor's `commitFilesView` shape if needed**

Confirm `EditorOrchestrator` already receives `CommitFilesTreeProvider`. It does (`commitFilesView` field). No change to the constructor signature — `showWorkingTreeComparison` is just another method on the same object.

- [ ] **Step 2: Add `openWorkingTreeFileDiff`**

Use `mcp__serena__insert_after_symbol` targeting `EditorOrchestrator/openCommitFileDiffWithStatus`:

```typescript
async openWorkingTreeFileDiff(
  relativePath: string,
  ref: string,
  refLabel: string,
  opts: { preview: boolean; status?: string }
): Promise<void> {
  const left = await this.createVirtualUri(ref, relativePath);

  let right: vscode.Uri;
  const gitRoot = await this.git.getGitRoot();
  const onDiskUri = vscode.Uri.file(path.join(gitRoot, relativePath));
  const fileMissing = opts.status === 'D' || !(await this.fileExists(onDiskUri));
  if (fileMissing) {
    const normalized = relativePath.replaceAll(path.sep, '/');
    right = vscode.Uri.parse(`intelligit:${encodeURIComponent('WORKTREE')}/${normalized}`);
    this.contentProvider.setContent(right, '');
  } else {
    right = onDiskUri;
  }

  const title = `${refLabel} ↔ working tree · ${relativePath}`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title, {
    preview: opts.preview,
    preserveFocus: false
  });
}

private async fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 3: Add `openCompareWithRevisionForFile` and `openCompareWithRevisionForFolder`**

Append after `openWorkingTreeFileDiff`:

```typescript
async openCompareWithRevisionForFile(
  relativePath: string,
  ref: string,
  refLabel: string
): Promise<void> {
  await this.openWorkingTreeFileDiff(relativePath, ref, refLabel, { preview: false });
}

async openCompareWithRevisionForFolder(
  folderRelPath: string,
  ref: string,
  refLabel: string
): Promise<void> {
  const files = await this.git.getFilesChangedBetweenWorkingTreeAndRef(ref, folderRelPath || '.');
  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      `No differences in ${folderRelPath || 'workspace'} against ${refLabel}.`
    );
    return;
  }

  await this.commitFilesView.showWorkingTreeComparison({
    ref,
    refLabel,
    scopePath: folderRelPath,
    files
  });

  const first = files[0];
  await this.openWorkingTreeFileDiff(first.path, ref, refLabel, {
    preview: true,
    status: first.status
  });
}
```

- [ ] **Step 4: Update the `commitFilesView` field type on `EditorOrchestrator`**

Currently typed as `CommitFilesTreeProvider`. Confirm `showWorkingTreeComparison` is reachable on that type after Task 3. No change required.

- [ ] **Step 5: Build & typecheck**

```bash
npm run check-types
npm run compile
npm run lint
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/editor/editorOrchestrator.ts
git commit -m "$(cat <<'EOF'
feat(editor): orchestrate compare-with-revision for files and folders

Adds openWorkingTreeFileDiff (right side = on-disk file:// URI for
live diffs, virtual empty for deleted files), plus the file/folder
entry points called by the new command. Folder mode populates the
Commit Details view and opens the first file in preview so subsequent
clicks reuse the same tab.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Register `intelliGit.compareWithRevision` & file-click command

**Goal:** Wire the Explorer-context-menu command and the per-tree-item file-click command in the controller.

**Files:**
- Modify: `src/commands/commandController.ts`

**Acceptance Criteria:**
- [ ] `intelliGit.compareWithRevision` registered. Handler:
  - Coerces the argument via `asFileResourceUri` to a `file://` URI.
  - Surfaces "Right-click a file or folder in the workspace to compare." (warning) if no URI.
  - Computes repo-relative path via `git.toRepoRelative(uri.fsPath)`. Errors with "Not inside a Git repository." (error toast) if undefined.
  - Calls `vscode.workspace.fs.stat(uri)` to determine `FileType.Directory`.
  - Calls `pickRevisionToCompare(this.git, this.state.branches, this.state.tags)`. Returns silently on cancel.
  - Dispatches to `editor.openCompareWithRevisionForFile(...)` or `editor.openCompareWithRevisionForFolder(...)`.
- [ ] `intelliGit.workingTreeCompare.openFileDiff` registered. Handler:
  - Casts the arg to `WorkingTreeCompareFileTreeItem`.
  - Calls `editor.openWorkingTreeFileDiff(item.filePath, item.ref, item.refLabel, { preview: true, status: item.status })`.

**Verify:** `npm run check-types && npm run compile && npm run lint` all pass; manual test (see Manual Test Plan after Task 7).

**Steps:**

- [ ] **Step 1: Add imports**

Add to the imports at the top of `commandController.ts`:

```typescript
import { CommitActionContext, CommitFileTreeItem, RevisionFileTreeItem, WorkingTreeCompareFileTreeItem } from '../providers/commitFilesTreeProvider';
import { pickRevisionToCompare } from '../views/revisionPicker';
```

- [ ] **Step 2: Add a `WorkingTreeCompareFileTreeItem` arg coercer next to the others**

Use `mcp__serena__search_for_pattern` to find the `asRevisionViewFileItem` declaration, then insert directly after it:

```typescript
const asWorkingTreeCompareFileItem = (value: unknown): WorkingTreeCompareFileTreeItem | undefined =>
  value instanceof WorkingTreeCompareFileTreeItem ? value : undefined;
```

- [ ] **Step 3: Register `intelliGit.compareWithRevision`**

Add the registration block immediately after the existing `intelliGit.fileHistory.open` registration. Use `mcp__serena__search_for_pattern` to locate `register('intelliGit.fileHistory.open'`, then append after that block:

```typescript
register('intelliGit.compareWithRevision', async (arg?: unknown) => {
  const uri = asFileResourceUri(arg);
  if (!uri) {
    void vscode.window.showWarningMessage('Right-click a file or folder in the workspace to compare.');
    return;
  }

  const repoRelative = this.git.toRepoRelative(uri.fsPath);
  if (!repoRelative && repoRelative !== '') {
    void vscode.window.showErrorMessage('Not inside a Git repository.');
    return;
  }

  let isDirectory = false;
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Could not stat target: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  const selection = await pickRevisionToCompare(this.git, this.state.branches, this.state.tags);
  if (!selection) {
    return;
  }

  if (isDirectory) {
    await this.editor.openCompareWithRevisionForFolder(repoRelative, selection.ref, selection.label);
  } else {
    await this.editor.openCompareWithRevisionForFile(repoRelative, selection.ref, selection.label);
  }
});

register('intelliGit.workingTreeCompare.openFileDiff', async (arg?: unknown) => {
  const item = asWorkingTreeCompareFileItem(arg);
  if (!item) {
    return;
  }
  await this.editor.openWorkingTreeFileDiff(item.filePath, item.ref, item.refLabel, {
    preview: true,
    status: item.status
  });
});
```

> Note on `repoRelative === ''`: when the user right-clicks the repo root itself, `toRepoRelative` returns `''`. That is valid (whole-repo scope) for folder mode; the orchestrator already maps `''` to `.` for git scope.

- [ ] **Step 4: Build & lint**

```bash
npm run check-types
npm run compile
npm run lint
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/commands/commandController.ts
git commit -m "$(cat <<'EOF'
feat(commands): register compare-with-revision Explorer action

Wires the new Explorer command to the revision picker and orchestrator,
plus a dedicated openFileDiff command used by the working-tree-compare
tree items so folder browsing reuses one preview tab.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Manifest contribution (`package.json`)

**Goal:** Surface the command in the Explorer context menu and hide it from the command palette.

**Files:**
- Modify: `package.json`

**Acceptance Criteria:**
- [ ] New entry under `contributes.commands`:
  ```json
  { "command": "intelliGit.compareWithRevision", "title": "Compare with Revision…" }
  ```
- [ ] New entry under `contributes.menus["explorer/context"]`:
  ```json
  { "command": "intelliGit.compareWithRevision", "when": "resourceScheme == file", "group": "navigation@10" }
  ```
- [ ] New entry under `contributes.menus.commandPalette`:
  ```json
  { "command": "intelliGit.compareWithRevision", "when": "false" }
  ```
- [ ] No declaration is needed for `intelliGit.workingTreeCompare.openFileDiff` (it's invoked only programmatically via tree-item `command`, like the existing `intelliGit.graph.openFileDiff` which is also undeclared in `commandPalette`-only entries; declare with `commandPalette: when: false` if linter / `vsce` complains).

**Verify:** `npm run vscode:prepublish` succeeds (this runs `check-types` + `bundle` together). No new Code lints around manifest.

**Steps:**

- [ ] **Step 1: Add command contribution**

Edit `package.json`. Inside `contributes.commands`, add (alphabetical neighbours OK; place it near other `compareWith…` entries):

```json
{
  "command": "intelliGit.compareWithRevision",
  "title": "Compare with Revision…"
}
```

Also add the helper command (so `vsce` accepts it cleanly):

```json
{
  "command": "intelliGit.workingTreeCompare.openFileDiff",
  "title": "Open Working-Tree Compare File Diff"
}
```

- [ ] **Step 2: Add the explorer/context entry**

Inside `contributes.menus["explorer/context"]`, append:

```json
{
  "command": "intelliGit.compareWithRevision",
  "when": "resourceScheme == file",
  "group": "navigation@10"
}
```

- [ ] **Step 3: Hide both new commands from the palette**

Inside `contributes.menus.commandPalette`, append:

```json
{ "command": "intelliGit.compareWithRevision", "when": "true" },
{ "command": "intelliGit.workingTreeCompare.openFileDiff", "when": "false" }
```

> The first entry is visible (palette `true`) because users can invoke it via the palette when they have a file open — VS Code passes the active editor's URI as the arg. The second is internal-only.

- [ ] **Step 4: Verify the manifest builds**

```bash
npm run check-types
npm run bundle
```

Expected: success.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
feat(manifest): contribute compare-with-revision Explorer menu

Adds the command + Explorer context-menu binding (files and folders)
and registers the internal preview-diff command used by the working-
tree compare tree items.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Documentation

**Goal:** Document the new feature in the README and changelog.

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Acceptance Criteria:**
- [ ] README has a short subsection (or bullet) under the existing feature list / Explorer section describing the **Compare with Revision** action: works on files and folders, opens a sectioned picker (branches, tags, commit SHAs), folders open the Commit Details view with preview diffs.
- [ ] CHANGELOG has an entry under the next pending version describing the feature.

**Verify:** Manual review of the diff. README renders without broken markdown.

**Steps:**

- [ ] **Step 1: Read current README structure**

```bash
sed -n '1,80p' README.md
```

Identify the most appropriate section (likely "Features" or an Explorer-related subsection).

- [ ] **Step 2: Add the feature entry to README**

Use the existing tone of the README. Suggested wording:

```markdown
### Compare with Revision

Right-click any file or folder in the Explorer and choose **Compare with Revision…** to diff it against the same path at any branch, tag, or commit.

- The picker is grouped by Local branches, Remote branches, and Tags. Type a commit SHA to look up an arbitrary commit on the fly.
- For files, the diff opens with the chosen revision on the left and your live working-tree on the right.
- For folders, the **Commit Details** view lists the changed files and the first one opens automatically. Clicking other files in the list reuses the same diff tab.
```

- [ ] **Step 3: Add a CHANGELOG entry**

Look at the existing format (`grep -n '^##' CHANGELOG.md | head -5`). Add an entry such as:

```markdown
## [Unreleased]

### Added
- **Compare with Revision** action in the Explorer context menu. Works for files and folders, with a sectioned picker (branches/tags/commits) and live working-tree diffs. Folder mode lists changed files in the Commit Details view and opens diffs in a preview tab that is reused as you click through.
```

(If the changelog already has an `[Unreleased]` block, append the bullet under `### Added`. If it has only versioned blocks, create the `[Unreleased]` block at the top.)

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs: document compare-with-revision Explorer action

Adds README feature description and CHANGELOG entry for the new
Explorer context-menu action that diffs any file or folder against
a chosen branch, tag, or commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Manual Test Plan (run after Task 7 before merging)

After `npm run bundle` and launching the extension in the VS Code Extension Host:

1. **File, modified.** Edit a tracked file. Right-click it in Explorer → **Compare with Revision…** → pick `HEAD`. Expect a diff editor titled `HEAD ↔ working tree · <path>` with the chosen revision on the left and live edits on the right.
2. **File, deleted.** Delete a tracked file in the working tree, then right-click another file in Explorer → pick `HEAD`. Diff still opens with non-empty left, empty right (synthetic). Then right-click the deleted file's parent folder and pick `HEAD` (folder mode) — verify the deleted file appears in the Commit Details list.
3. **Picker — tag.** Repeat (1), pick a tag instead of a branch.
4. **Picker — SHA prefix.** Type the first 7 chars of a known commit. A `$(git-commit) <short>` item appears. Selecting it opens the diff against that commit.
5. **Picker — bad SHA.** Type `deadbeef` (no such commit). No synthetic item appears; busy indicator clears.
6. **Folder with diffs.** Right-click a folder containing modified + untracked files → pick a ref. Commit Details view opens with both rows; "Untracked" description is present on the new file. The first file's diff opens in **preview** mode (italic-titled tab). Click another file → the same tab updates in place.
7. **Folder, no diffs.** Right-click a folder whose contents are identical to the chosen ref. An info notification appears; the Commit Details view is not opened/changed.
8. **Outside repo.** Right-click a file in a folder that's not in any Git repo. Error toast: "Not inside a Git repository." Picker does not open.
9. **Cancel picker.** Esc out of the picker. No view changes, no toast.

---

## Self-Review

- **Spec coverage:** Every spec section maps to a task — picker (Task 2), file diff (Task 4 / 5), folder mode (Tasks 3 / 4 / 5), explorer wiring (Task 5 / 6), error handling (covered in Tasks 4 & 5), tests (Tasks 0–2), docs (Task 7).
- **Type consistency:** `RevisionSelection`, `WorkingTreeFileChange`, `ResolvedCommitMeta` defined once and used consistently. `WorkingTreeCompareFileTreeItem` carries `(ref, refLabel, filePath, status, untracked)` and is referenced identically in Tasks 3, 4, 5.
- **Placeholder scan:** No TBDs; every step shows code or an exact command.
- **Diff direction:** Left = revision X, right = working tree everywhere (orchestrator title and method bodies, picker docs, README).
