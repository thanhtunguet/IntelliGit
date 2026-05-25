# Git Graph Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add server-side pagination (`git log --skip=N`) to both the Git Graph TreeView and the Filter Graph webview so users can browse all commits beyond the initial 200-commit cap.

**Architecture:** `GitService.getGraph` gains a `skip` parameter. `StateStore` appends pages into `_graph` and exposes `graphHasMore` to signal when more commits exist. The TreeView shows a "Load More..." item; the Filter Graph webview uses an `IntersectionObserver` scroll sentinel to load more commits automatically.

**Tech Stack:** TypeScript, VS Code extension API, Node `node:test` + `assert`, Handlebars templates, vanilla browser JS.

---

## File Map

| File | Change |
|------|--------|
| `src/services/gitService.ts` | Add `skip` param to `getGraph` |
| `src/state/stateStore.ts` | Add `_graphHasMore`, `graphHasMore`, update `loadGraph`, add `loadMoreGraph` |
| `src/providers/graphTreeProvider.ts` | Export `LoadMoreTreeItem`, update `getChildren` |
| `src/commands/commandController.ts` | Register `graph.loadMore` command, update `GraphFilterView.open` wiring |
| `src/views/graphFilterView.ts` | Update `GraphFilterHandlers`, `IncomingMessage`, `handleMessage`, `getInitial` type, `postInitial` |
| `src/views/templates/graphFilterView.hbs` | Add sentinel div, `appendRows`, `updatePreviewHeader`, `IntersectionObserver` |
| `src/test/graphPagination.test.ts` | New: unit tests for state + tree provider |

---

### Task 1: Add `skip` parameter to `GitService.getGraph`

**Goal:** Make `getGraph` accept a `skip` offset and pass it to `git log --skip=N`.

**Files:**
- Modify: `src/services/gitService.ts:931-987`

**Acceptance Criteria:**
- [ ] `getGraph(200, 0, {})` produces no `--skip` arg
- [ ] `getGraph(200, 200, {})` produces `--skip=200` in the git args
- [ ] All existing callers still compile (they pass positional args, so adding a middle param breaks them — see Steps)

**Verify:** `npm run check-types` → no errors

**Steps:**

- [ ] **Step 1: Update the `getGraph` signature and arg list**

Open `src/services/gitService.ts`. Find the method at line 931. Replace just the signature line and the `args` array construction:

**Before:**
```typescript
async getGraph(maxCount: number, filters?: CommitFilters): Promise<GraphCommit[]> {
  const format = [
    '%m',
    '%H',
    '%h',
    '%P',
    '%D',
    '%an',
    '%aI',
    '%s'
  ].join(FIELD_SEPARATOR);

  const args = ['log', '--date=iso-strict', '--decorate=full', `--max-count=${maxCount}`, `--format=${format}${RECORD_SEPARATOR}`];
```

**After:**
```typescript
async getGraph(maxCount: number, skip = 0, filters?: CommitFilters): Promise<GraphCommit[]> {
  const format = [
    '%m',
    '%H',
    '%h',
    '%P',
    '%D',
    '%an',
    '%aI',
    '%s'
  ].join(FIELD_SEPARATOR);

  const args = [
    'log',
    '--date=iso-strict',
    '--decorate=full',
    `--max-count=${maxCount}`,
    ...(skip > 0 ? [`--skip=${skip}`] : []),
    `--format=${format}${RECORD_SEPARATOR}`
  ];
```

- [ ] **Step 2: Fix the existing caller that skips `skip`**

There is one internal call at line ~990 that uses the old two-arg form. Find it:

```typescript
const [commit] = await this.getGraph(1, { branch: sha });
```

Update it to pass `skip = 0` explicitly:

```typescript
const [commit] = await this.getGraph(1, 0, { branch: sha });
```

Also find the caller in `commandController.ts` (around line 2283):

```typescript
const commits = await this.git.getGraph(maxCommits, { branch: ref });
```

Update it:

```typescript
const commits = await this.git.getGraph(maxCommits, 0, { branch: ref });
```

- [ ] **Step 3: Type-check**

```bash
npm run check-types
```

Expected: no errors. If TypeScript complains about callers, fix each one by inserting `0` as the second argument.

- [ ] **Step 4: Commit**

```bash
git add src/services/gitService.ts src/commands/commandController.ts
git commit -m "feat(graph): add skip parameter to GitService.getGraph"
```

---

### Task 2: Add pagination state to `StateStore`

**Goal:** `StateStore` tracks whether more commits exist (`_graphHasMore`) and exposes `loadMoreGraph()` to fetch and append the next page.

**Files:**
- Modify: `src/state/stateStore.ts`
- Create: `src/test/graphPagination.test.ts`

**Acceptance Criteria:**
- [ ] `loadMoreGraph()` called on empty state: calls `getGraph(200, 0, {})`, sets `graphHasMore = true` when 200 returned
- [ ] `loadMoreGraph()` called again: calls `getGraph(200, 200, {})`, appends results
- [ ] `loadMoreGraph()` receiving a partial page: sets `graphHasMore = false`
- [ ] `loadGraph()` (called by filter reset) resets `_graph` and `_graphHasMore`

**Verify:** `npm test` → all tests in `graphPagination.test.ts` pass

**Steps:**

- [ ] **Step 1: Write failing tests**

Create `src/test/graphPagination.test.ts`:

```typescript
import * as assert from 'assert';
import { describe, it } from 'node:test';
import * as vscode from 'vscode';
import { StateStore } from '../state/stateStore';
import { GitService } from '../services/gitService';
import { CommitFilters, GraphCommit } from '../types';

function makeCommit(sha: string): GraphCommit {
  return { graph: '-', sha, shortSha: sha.slice(0, 7), parents: [], refs: [], author: 'A', date: '2024-01-01T00:00:00Z', subject: 'msg' };
}

function makeFullPage(size = 200): GraphCommit[] {
  return Array.from({ length: size }, (_, i) => makeCommit(`a${String(i).padStart(39, '0')}`));
}

function makeStubGit(getGraph: (maxCount: number, skip: number, filters?: CommitFilters) => Promise<GraphCommit[]>): unknown {
  return {
    isRepo: async () => true,
    getLocalBranches: async () => [],
    getRemoteBranches: async () => [],
    getRemoteFetchUrls: async () => new Map<string, string>(),
    getTagsBasic: async () => [],
    getTagAvailabilityByRemote: async () => new Map<string, Set<string>>(),
    mergeTagAvailability: (tags: readonly unknown[]) => tags,
    getStashes: async () => [],
    getWorkingTreeChanges: async () => [],
    getOperationState: async () => ({ kind: 'none' as const }),
    getMergeConflicts: async () => [],
    getWorktrees: async () => [],
    getSubmodules: async () => [],
    getGraph,
  };
}

function makeWorkspaceState(): vscode.Memento {
  const data = new Map<string, unknown>();
  return {
    keys: () => Array.from(data.keys()) as readonly string[],
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      data.has(key) ? (data.get(key) as T) : defaultValue,
    update: async (key: string, value: unknown) => { data.set(key, value); },
  } as vscode.Memento;
}

const stubLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, dispose: () => {} };

describe('StateStore graph pagination', () => {
  it('loadMoreGraph uses skip=0 on first call and appends results', async () => {
    const calls: Array<{ maxCount: number; skip: number }> = [];
    const page = makeFullPage(200);
    const stubGit = makeStubGit(async (maxCount, skip) => {
      calls.push({ maxCount, skip });
      return page;
    });
    const state = new StateStore(stubGit as never, stubLogger as never, { get: () => undefined } as never, makeWorkspaceState());

    await state.loadMoreGraph();

    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0], { maxCount: 200, skip: 0 });
    assert.strictEqual(state.graph.length, 200);
    assert.strictEqual(state.graphHasMore, true);
  });

  it('loadMoreGraph uses skip=prevLength on second call', async () => {
    const calls: Array<{ maxCount: number; skip: number }> = [];
    let callCount = 0;
    const stubGit = makeStubGit(async (maxCount, skip) => {
      calls.push({ maxCount, skip });
      callCount++;
      return callCount === 1 ? makeFullPage(200) : makeFullPage(50);
    });
    const state = new StateStore(stubGit as never, stubLogger as never, { get: () => undefined } as never, makeWorkspaceState());

    await state.loadMoreGraph();
    await state.loadMoreGraph();

    assert.deepStrictEqual(calls[1], { maxCount: 200, skip: 200 });
    assert.strictEqual(state.graph.length, 250);
    assert.strictEqual(state.graphHasMore, false);
  });

  it('loadMoreGraph sets graphHasMore=false on partial page', async () => {
    const stubGit = makeStubGit(async () => makeFullPage(42));
    const state = new StateStore(stubGit as never, stubLogger as never, { get: () => undefined } as never, makeWorkspaceState());

    await state.loadMoreGraph();

    assert.strictEqual(state.graphHasMore, false);
  });

  it('graphHasMore starts false before any load', () => {
    const stubGit = makeStubGit(async () => []);
    const state = new StateStore(stubGit as never, stubLogger as never, { get: () => undefined } as never, makeWorkspaceState());
    assert.strictEqual(state.graphHasMore, false);
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
npm test 2>&1 | grep -E "graphPagination|loadMoreGraph|graphHasMore|FAIL|ERROR" | head -20
```

Expected: compilation errors or test failures because `loadMoreGraph` and `graphHasMore` don't exist yet.

- [ ] **Step 3: Add `_graphHasMore` field and `graphHasMore` getter to `StateStore`**

Open `src/state/stateStore.ts`. Find the `private _graph: GraphCommit[] = [];` line (~line 64). Add after it:

```typescript
private _graphHasMore = false;
```

Find the `get graph(): GraphCommit[]` getter (~line 118). Add after the closing brace of that getter:

```typescript
get graphHasMore(): boolean {
  return this._graphHasMore;
}
```

- [ ] **Step 4: Update `loadGraph()` to set `_graphHasMore`**

Find `loadGraph()` (~line 350):

**Before:**
```typescript
private async loadGraph(): Promise<void> {
  const maxGraphCommits = getConfigValue<number>('maxGraphCommits', 200);
  this._graph = await this.git.getGraph(maxGraphCommits, this._graphFilters);
}
```

**After:**
```typescript
private async loadGraph(): Promise<void> {
  const maxGraphCommits = getConfigValue<number>('maxGraphCommits', 200);
  this._graph = await this.git.getGraph(maxGraphCommits, 0, this._graphFilters);
  this._graphHasMore = this._graph.length === maxGraphCommits;
}
```

- [ ] **Step 5: Add public `loadMoreGraph()` method**

Add it immediately after `loadGraph()`:

```typescript
async loadMoreGraph(): Promise<void> {
  const pageSize = getConfigValue<number>('maxGraphCommits', 200);
  const page = await this.git.getGraph(pageSize, this._graph.length, this._graphFilters);
  this._graph = [...this._graph, ...page];
  this._graphHasMore = page.length === pageSize;
  this.emitter.fire();
}
```

- [ ] **Step 6: Run tests — expect pass**

```bash
npm test 2>&1 | grep -E "graphPagination|✓|✗|FAIL|pass|fail" | head -20
```

Expected: all 4 `StateStore graph pagination` tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/state/stateStore.ts src/test/graphPagination.test.ts
git commit -m "feat(graph): add graphHasMore and loadMoreGraph to StateStore"
```

---

### Task 3: Add `LoadMoreTreeItem` to `GraphTreeProvider`

**Goal:** The Git Graph TreeView shows a "Load More..." item at the end of the list when more commits are available, and clicking it triggers the load.

**Files:**
- Modify: `src/providers/graphTreeProvider.ts`
- Modify: `src/test/graphPagination.test.ts` (add tree provider tests)

**Acceptance Criteria:**
- [ ] When `state.graphHasMore = true`, `getChildren()` returns commits + one `LoadMoreTreeItem` at the end
- [ ] When `state.graphHasMore = false`, `getChildren()` returns commits only
- [ ] `LoadMoreTreeItem` has `contextValue = 'graphLoadMore'`, `label = 'Load More...'`, and a command wired to `vscodeGitClient.graph.loadMore`

**Verify:** `npm test` → tree provider tests pass; `npm run check-types` → no errors

**Steps:**

- [ ] **Step 1: Add tree provider tests to `src/test/graphPagination.test.ts`**

Append to the existing test file:

```typescript
import { GraphTreeProvider, LoadMoreTreeItem } from '../providers/graphTreeProvider';
import { GitService } from '../services/gitService';

// Minimal StateStore-shaped stub for tree provider tests
function makeStateStub(graph: GraphCommit[], graphHasMore: boolean): unknown {
  return {
    graph,
    graphHasMore,
    onDidChange: (_handler: () => void) => ({ dispose: () => {} }),
  };
}

describe('GraphTreeProvider pagination', () => {
  it('getChildren includes LoadMoreTreeItem when graphHasMore is true', async () => {
    const commits = [makeCommit('abc1234' + '0'.repeat(33))];
    const state = makeStateStub(commits, true);
    const provider = new GraphTreeProvider(state as never, {} as never);
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 2);
    const last = children[children.length - 1];
    assert.ok(last instanceof LoadMoreTreeItem, 'last item should be LoadMoreTreeItem');
    assert.strictEqual(last.contextValue, 'graphLoadMore');
  });

  it('getChildren omits LoadMoreTreeItem when graphHasMore is false', async () => {
    const commits = [makeCommit('abc1234' + '0'.repeat(33))];
    const state = makeStateStub(commits, false);
    const provider = new GraphTreeProvider(state as never, {} as never);
    const children = await provider.getChildren();
    assert.strictEqual(children.length, 1);
    const last = children[children.length - 1];
    assert.ok(!(last instanceof LoadMoreTreeItem));
  });
});
```

- [ ] **Step 2: Run tests — expect failures**

```bash
npm test 2>&1 | grep -E "graphPagination|LoadMoreTreeItem|FAIL|ERROR" | head -10
```

Expected: compilation error — `LoadMoreTreeItem` not exported.

- [ ] **Step 3: Add and export `LoadMoreTreeItem` in `graphTreeProvider.ts`**

Open `src/providers/graphTreeProvider.ts`. Find the type alias `type GraphNode = ...` (~line 65). Insert the new class **before** it:

```typescript
export class LoadMoreTreeItem extends vscode.TreeItem {
  constructor() {
    super('Load More...', vscode.TreeItemCollapsibleState.None);
    this.command = {
      title: 'Load More',
      command: 'vscodeGitClient.graph.loadMore',
      arguments: []
    };
    this.contextValue = 'graphLoadMore';
    this.iconPath = new vscode.ThemeIcon('chevron-down');
  }
}
```

- [ ] **Step 4: Update `GraphNode` type alias**

Find:
```typescript
type GraphNode = GraphCommitTreeItem | GraphCommitFolderTreeItem | GraphCommitFileTreeItem;
```

Replace with:
```typescript
type GraphNode = GraphCommitTreeItem | GraphCommitFolderTreeItem | GraphCommitFileTreeItem | LoadMoreTreeItem;
```

- [ ] **Step 5: Update `getChildren` to append `LoadMoreTreeItem`**

Find the root-level `getChildren` return statement (~line 142):

```typescript
return this.state.graph.map((commit) => new GraphCommitTreeItem(commit));
```

Replace with:

```typescript
const items: GraphNode[] = this.state.graph.map((commit) => new GraphCommitTreeItem(commit));
if (this.state.graphHasMore) {
  items.push(new LoadMoreTreeItem());
}
return items;
```

- [ ] **Step 6: Run tests — expect pass**

```bash
npm test 2>&1 | grep -E "graphPagination|✓|✗|FAIL|pass|fail" | head -20
```

Expected: all 6 tests (4 state + 2 tree provider) pass.

- [ ] **Step 7: Type-check**

```bash
npm run check-types
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/providers/graphTreeProvider.ts src/test/graphPagination.test.ts
git commit -m "feat(graph): add LoadMoreTreeItem to GraphTreeProvider"
```

---

### Task 4: Wire `loadMore` command and update `GraphFilterView` controller

**Goal:** Register the `vscodeGitClient.graph.loadMore` VS Code command. Update `GraphFilterView` to handle `loadMore` incoming messages, post `appendCommits`/`loadMoreError` responses, and include `hasMore` in the `init` message.

**Files:**
- Modify: `src/commands/commandController.ts`
- Modify: `src/views/graphFilterView.ts`

**Acceptance Criteria:**
- [ ] `vscodeGitClient.graph.loadMore` command calls `state.loadMoreGraph()`
- [ ] `GraphFilterHandlers` interface includes `loadMore(): Promise<{ commits: GraphCommit[]; hasMore: boolean }>`
- [ ] `IncomingMessage` union includes `{ type: 'loadMore' }`
- [ ] `handleMessage` case `'loadMore'`: on success posts `{ type: 'appendCommits', commits, hasMore }`; on failure posts `{ type: 'loadMoreError' }`
- [ ] `getInitial` callback and `postInitial()` include `hasMore: boolean`
- [ ] `commandController.ts` wires `loadMore` handler and passes `hasMore` in `getInitial`

**Verify:** `npm run check-types` → no errors

**Steps:**

- [ ] **Step 1: Update `GraphFilterHandlers` interface in `graphFilterView.ts`**

Open `src/views/graphFilterView.ts`. Find:

```typescript
export interface GraphFilterHandlers {
  apply(filters: CommitFilters): Promise<void>;
  clear(): Promise<void>;
  openCommitDetails(sha: string, subject: string): Promise<void>;
  openCommitRangeDetails(shas: readonly string[]): Promise<void>;
  getCommitFiles(sha: string): Promise<string[]>;
  openFileDiff(sha: string, filePath: string): Promise<void>;
}
```

Replace with:

```typescript
export interface GraphFilterHandlers {
  apply(filters: CommitFilters): Promise<void>;
  clear(): Promise<void>;
  openCommitDetails(sha: string, subject: string): Promise<void>;
  openCommitRangeDetails(shas: readonly string[]): Promise<void>;
  getCommitFiles(sha: string): Promise<string[]>;
  openFileDiff(sha: string, filePath: string): Promise<void>;
  loadMore(): Promise<{ commits: GraphCommit[]; hasMore: boolean }>;
}
```

- [ ] **Step 2: Add `loadMore` to `IncomingMessage` union**

Find:
```typescript
type IncomingMessage =
  | { type: 'apply'; filters: CommitFilters }
  | { type: 'clear' }
  | { type: 'close' }
  | { type: 'openCommitDetails'; sha: string; subject: string }
  | { type: 'openCommitRangeDetails'; shas: string[] }
  | { type: 'loadCommitFiles'; sha: string }
  | { type: 'openCommitFile'; sha: string; filePath: string }
  | CommitActionMessage;
```

Replace with:

```typescript
type IncomingMessage =
  | { type: 'apply'; filters: CommitFilters }
  | { type: 'clear' }
  | { type: 'close' }
  | { type: 'loadMore' }
  | { type: 'openCommitDetails'; sha: string; subject: string }
  | { type: 'openCommitRangeDetails'; shas: string[] }
  | { type: 'loadCommitFiles'; sha: string }
  | { type: 'openCommitFile'; sha: string; filePath: string }
  | CommitActionMessage;
```

- [ ] **Step 3: Update `getInitial` type in `GraphFilterView` constructor**

Find the constructor parameter type:

```typescript
private readonly getInitial: () => { filters: CommitFilters; branches: BranchRef[]; commits: GraphCommit[] }
```

Replace with:

```typescript
private readonly getInitial: () => { filters: CommitFilters; branches: BranchRef[]; commits: GraphCommit[]; hasMore: boolean }
```

Also update the `static open` signature to match:

```typescript
static open(
  handlers: GraphFilterHandlers,
  getInitial: () => { filters: CommitFilters; branches: BranchRef[]; commits: GraphCommit[]; hasMore: boolean }
): GraphFilterView {
```

- [ ] **Step 4: Update `postInitial()` to send `hasMore`**

Find:

```typescript
private postInitial(): void {
  const { filters, branches, commits } = this.getInitial();
  void this.panel.webview.postMessage({
    type: 'init',
    filters,
    branches: collectBranchNames(branches),
    commits: serializeCommits(commits)
  });
}
```

Replace with:

```typescript
private postInitial(): void {
  const { filters, branches, commits, hasMore } = this.getInitial();
  void this.panel.webview.postMessage({
    type: 'init',
    filters,
    branches: collectBranchNames(branches),
    commits: serializeCommits(commits),
    hasMore
  });
}
```

- [ ] **Step 5: Add `'loadMore'` case to `handleMessage`**

Find the `switch (message.type)` block. Add a new case **before** the existing first case:

```typescript
case 'loadMore': {
  try {
    const { commits, hasMore } = await this.handlers.loadMore();
    void this.panel.webview.postMessage({ type: 'appendCommits', commits: serializeCommits(commits), hasMore });
  } catch {
    void this.panel.webview.postMessage({ type: 'loadMoreError' });
  }
  return;
}
```

- [ ] **Step 6: Register `vscodeGitClient.graph.loadMore` command in `commandController.ts`**

Open `src/commands/commandController.ts`. Find the `register('vscodeGitClient.graph.filter', ...)` block (~line 1401). Insert a new registration **after** the `register('vscodeGitClient.graph.clearFilter', ...)` block (~line 1426):

```typescript
register('vscodeGitClient.graph.loadMore', async () => {
  await this.state.loadMoreGraph();
});
```

- [ ] **Step 7: Update `GraphFilterView.open` call to add `loadMore` and `hasMore`**

Find the `GraphFilterView.open(...)` call (~line 1402). Update the handlers object and `getInitial` callback:

Add two new entries — `loadMore` handler and `hasMore` in `getInitial`. The existing handlers are unchanged; add the new ones shown below.

In the handlers object, add after `openFileDiff`:
```typescript
loadMore: async () => {
  const prevLength = this.state.graph.length;
  await this.state.loadMoreGraph();
  return {
    commits: this.state.graph.slice(prevLength),
    hasMore: this.state.graphHasMore
  };
}
```

In the `getInitial` callback, add `hasMore` to the returned object:
```typescript
() => ({
  filters: this.state.graphFilters,
  branches: this.state.branches,
  commits: this.state.graph,
  hasMore: this.state.graphHasMore   // ← add this line
})
```

- [ ] **Step 8: Type-check**

```bash
npm run check-types
```

Expected: no errors. If any callers of `GraphFilterView.open` fail, they need `hasMore` added to their `getInitial` callbacks.

- [ ] **Step 9: Commit**

```bash
git add src/views/graphFilterView.ts src/commands/commandController.ts
git commit -m "feat(graph): wire loadMore command and update GraphFilterView controller"
```

---

### Task 5: Update `graphFilterView.hbs` webview for scroll pagination

**Goal:** Add an `IntersectionObserver` scroll sentinel, an `appendRows` function that appends only new matching rows without full re-render, and a `updatePreviewHeader` helper that shows the "scroll to load more" hint when more commits are available.

**Files:**
- Modify: `src/views/templates/graphFilterView.hbs`

**Acceptance Criteria:**
- [ ] `state` object has `hasMore: false` initially
- [ ] `init` message sets `state.hasMore` from `msg.hasMore`
- [ ] `appendCommits` message appends only new rows (filtered), updates `state.commits`, updates header
- [ ] `loadMoreError` message clears `state.loading` so user can retry by scrolling
- [ ] `IntersectionObserver` watches `#load-more-sentinel`; fires only when `state.hasMore && !state.loading`
- [ ] `updatePreviewHeader()` shows `"scroll to load more"` suffix when `state.hasMore`
- [ ] `MAX_PREVIEW` cap is removed (commits load on demand from server now)

**Verify:** Manual — open Filter Graph, scroll to bottom, observe new commits appending; banner updates. TypeScript build still passes: `npm run compile`.

**Steps:**

- [ ] **Step 1: Add sentinel `div` to the HTML**

In `graphFilterView.hbs`, find the `.preview-table-wrap` section:

```handlebars
<div class="preview-table-wrap">
  {{> partials/commitTable tbodyId="preview-body"}}
</div>
```

Replace with:

```handlebars
<div class="preview-table-wrap">
  {{> partials/commitTable tbodyId="preview-body"}}
  <div id="load-more-sentinel" style="height:1px"></div>
</div>
```

- [ ] **Step 2: Remove `MAX_PREVIEW` and add `hasMore` to state**

Find:

```js
const MAX_PREVIEW = 200;
const SHOW_APPLY = {{#if showApply}}true{{else}}false{{/if}};
const state = {
  branches: [],
  authors: [],
  commits: [],
  loading: false
};
```

Replace with:

```js
const SHOW_APPLY = {{#if showApply}}true{{else}}false{{/if}};
const state = {
  branches: [],
  authors: [],
  commits: [],
  loading: false,
  hasMore: false
};
```

- [ ] **Step 3: Extract `updatePreviewHeader()` and update `renderPreview()`**

Find the `renderPreview()` function. It currently sets `previewHeader.textContent` inline. Replace the entire function with two functions:

**Before:**
```js
function renderPreview() {
  if (state.loading) {
    previewHeader.textContent = 'Loading commits...';
    previewBody.innerHTML = '<tr><td colspan="4">Loading commits...</td></tr>';
    return;
  }
  const filtered = getFilteredCommits();
  const shown = filtered.slice(0, MAX_PREVIEW);
  previewHeader.textContent = 'Matching commits: ' + filtered.length + (filtered.length > MAX_PREVIEW ? ' (showing first ' + MAX_PREVIEW + ')' : '');
  if (shown.length === 0) {
    previewBody.innerHTML = '<tr><td colspan="4">No commits match current filters</td></tr>';
    return;
  }
  previewBody.innerHTML = shown.map((commit) => {
```

**After (replace just the function body above through the closing of `renderPreview`):**
```js
function updatePreviewHeader() {
  const filtered = getFilteredCommits();
  const suffix = state.hasMore ? ' (scroll to load more)' : '';
  previewHeader.textContent = 'Matching commits: ' + filtered.length + suffix;
}

function renderPreview() {
  if (state.loading) {
    previewHeader.textContent = 'Loading commits...';
    previewBody.innerHTML = '<tr><td colspan="4">Loading commits...</td></tr>';
    return;
  }
  const filtered = getFilteredCommits();
  updatePreviewHeader();
  if (filtered.length === 0) {
    previewBody.innerHTML = '<tr><td colspan="4">No commits match current filters</td></tr>';
    return;
  }
  previewBody.innerHTML = filtered.map((commit) => {
    const sha = escapeHtml(commit.sha || '');
    const subject = escapeHtml(commit.subject || '');
    const author = escapeHtml(commit.author || '');
    const timestamp = Number(commit.dateTimestamp || 0);
    const full = escapeHtml(commit.dateTitle || '');
    const dateText = escapeHtml(commit.dateLabel || '');
    const graph = escapeHtml(renderGraphGlyph(commit.graph));
    return '<tr class="commit-row" data-sha="' + sha + '" data-subject="' + subject + '" data-author="' + author + '" data-timestamp="' + timestamp + '" data-side="filter" title="' + sha + '"><td class="col-graph copyable" title="Copy commit id: ' + sha + '">' + graph + '</td><td class="col-subject" title="' + subject + '">' + subject + '</td><td class="col-author" title="' + author + '">' + author + '</td><td class="col-date muted"><span title="' + full + '">' + dateText + '</span></td></tr>';
  }).join('');
}
```

Note: the row HTML template is unchanged — just the `slice(0, MAX_PREVIEW)` cap is removed and `shown` is replaced with `filtered`.

- [ ] **Step 4: Add `appendRows(newCommits)` function**

Add it immediately after `renderPreview()`:

```js
function appendRows(newCommits) {
  const f = (() => {
    const msg = collect();
    const message = (msg.message || '').trim().toLowerCase();
    const branch = (msg.branch || '').trim().toLowerCase();
    const author = (msg.author || '').trim().toLowerCase();
    const since = parseSince(msg.since || '');
    const until = parseUntil(msg.until || '');
    return function matchesFilter(commit) {
      const subject = String(commit.subject || '').toLowerCase();
      const sha = String(commit.sha || '').toLowerCase();
      const refs = Array.isArray(commit.refs) ? commit.refs.join(' ') : '';
      const refsLower = refs.toLowerCase();
      const authorLower = String(commit.author || '').toLowerCase();
      const commitDate = Number(commit.dateTimestamp || 0);
      const messageOk = !message || subject.includes(message) || sha.includes(message);
      const branchOk = !branch || refsLower.includes(branch);
      const authorOk = !author || authorLower.includes(author);
      const sinceOk = since === undefined || (Number.isFinite(commitDate) && commitDate >= since);
      const untilOk = until === undefined || (Number.isFinite(commitDate) && commitDate <= until);
      return messageOk && branchOk && authorOk && sinceOk && untilOk;
    };
  })();

  const matchingRows = newCommits.filter(f).map((commit) => {
    const sha = escapeHtml(commit.sha || '');
    const subject = escapeHtml(commit.subject || '');
    const author = escapeHtml(commit.author || '');
    const timestamp = Number(commit.dateTimestamp || 0);
    const full = escapeHtml(commit.dateTitle || '');
    const dateText = escapeHtml(commit.dateLabel || '');
    const graph = escapeHtml(renderGraphGlyph(commit.graph));
    return '<tr class="commit-row" data-sha="' + sha + '" data-subject="' + subject + '" data-author="' + author + '" data-timestamp="' + timestamp + '" data-side="filter" title="' + sha + '"><td class="col-graph copyable" title="Copy commit id: ' + sha + '">' + graph + '</td><td class="col-subject" title="' + subject + '">' + subject + '</td><td class="col-author" title="' + author + '">' + author + '</td><td class="col-date muted"><span title="' + full + '">' + dateText + '</span></td></tr>';
  });

  if (previewBody.querySelector('td[colspan]')) {
    previewBody.innerHTML = '';
  }

  if (matchingRows.length > 0) {
    previewBody.insertAdjacentHTML('beforeend', matchingRows.join(''));
  }

  updatePreviewHeader();
}
```

- [ ] **Step 5: Update the `window.addEventListener('message', ...)` handler**

Find the `init` message handler block and add `appendCommits` and `loadMoreError` handling:

```js
window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'loading') {
    state.loading = Boolean(msg.loading);
    renderPreview();
    return;
  }
  if (msg && msg.type === 'init') {
    state.loading = false;
    state.hasMore = Boolean(msg.hasMore);
    const f = msg.filters || {};
    messageInput.value = f.message || '';
    branchInput.value = f.branch || '';
    authorInput.value = f.author || '';
    sinceInput.value = f.since || '';
    untilInput.value = f.until || '';
    state.branches = Array.isArray(msg.branches) ? msg.branches : [];
    state.commits = Array.isArray(msg.commits) ? msg.commits : [];
    state.authors = Array.from(
      new Set(state.commits.map((c) => (typeof c.author === 'string' ? c.author.trim() : '')).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b));
    branchAutocomplete.setSource(state.branches);
    authorAutocomplete.setSource(state.authors);
    renderPreview();
    return;
  }
  if (msg && msg.type === 'appendCommits') {
    state.loading = false;
    state.hasMore = Boolean(msg.hasMore);
    const newCommits = Array.isArray(msg.commits) ? msg.commits : [];
    state.commits = state.commits.concat(newCommits);
    const newAuthors = newCommits
      .map((c) => (typeof c.author === 'string' ? c.author.trim() : ''))
      .filter(Boolean);
    if (newAuthors.length > 0) {
      state.authors = Array.from(new Set([...state.authors, ...newAuthors])).sort((a, b) => a.localeCompare(b));
      authorAutocomplete.setSource(state.authors);
    }
    appendRows(newCommits);
    return;
  }
  if (msg && msg.type === 'loadMoreError') {
    state.loading = false;
    return;
  }
});
```

Note: remove the old `if (msg && msg.type === 'init')` block that existed before — replace it entirely with the block above.

- [ ] **Step 6: Add `IntersectionObserver` after the autocomplete setup**

Find the end of the script, just before `</script>`. Add before the closing tag:

```js
const loadMoreSentinel = document.getElementById('load-more-sentinel');
if (loadMoreSentinel && typeof IntersectionObserver !== 'undefined') {
  const loadMoreObserver = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && state.hasMore && !state.loading) {
      state.loading = true;
      vscode.postMessage({ type: 'loadMore' });
    }
  }, { threshold: 0.1 });
  loadMoreObserver.observe(loadMoreSentinel);
}
```

- [ ] **Step 7: Build and smoke-test**

```bash
npm run compile
```

Expected: no errors.

Open the extension in VS Code (press F5 to launch Extension Development Host). Run `Git Client: Filter Graph`. Scroll to the bottom of the commit list. New commits should load and append. The preview header should show `"Matching commits: N (scroll to load more)"` until all commits are loaded.

- [ ] **Step 8: Commit**

```bash
git add src/views/templates/graphFilterView.hbs
git commit -m "feat(graph): add IntersectionObserver pagination to Filter Graph webview"
```

---

## Done

After all 5 tasks, run the full test suite one final time:

```bash
npm test
```

All tests should pass. The Git Graph TreeView will show a "Load More..." item, and the Filter Graph webview will auto-load more commits as the user scrolls to the bottom.
