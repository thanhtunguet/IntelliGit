---
name: windows-performance
description: Root cause analysis and fixes for Windows-specific lag in IntelliGit (v0.15.4)
type: investigation
---

# Windows Lag Investigation — IntelliGit v0.15.4

## Symptom
Extension felt laggy on some Windows machines but not others. Not reproducible on macOS/Linux.

## Root Causes (ranked by impact)

### 1. Missing debounce on worktree & submodule file watchers (HIGH)
**File:** `src/state/stateStore.ts` — `attachAutoRefresh()`

`onWorktreeChange` and `onSubmoduleChange` callbacks previously called `refreshWorktrees()` / `refreshSubmodules()` directly, with no delay:

```typescript
// BEFORE
const onWorktreeChange = async () => { await this.refreshWorktrees(); };
```

On Windows, `ReadDirectoryChangesW` emits **multiple events per single logical fs operation** (unlike `inotify` on Linux which emits 1). Each event spawned a new `git` process immediately.

**Fix:** Use `requestRefresh(['worktrees'|'submodules'], { delayMs: 250 })` — the `RefreshScheduler` coalesces all events within the 250 ms window into a single run.

```typescript
// AFTER
const onWorktreeChange = async () => {
  await this.requestRefresh(['worktrees'], { delayMs: 250 });
};
```

The main `.git/{HEAD,index,...}` watcher already used `delayMs: 250`; the worktree/submodule watchers were the only ones missing it.

---

### 2. Sequential `stat()` calls in `getOperationState()` (HIGH on slow FS / AV)
**File:** `src/services/gitService.ts` — `getOperationState()`

Called on every `loadChanges()` (i.e., every change refresh). On the happy path (no active operation) the old code issued **5 sequential** `vscode.workspace.fs.stat()` calls:

```
await exists('rebase-merge')   // stat #1
await exists('rebase-apply')   // stat #2 — only if #1 = false
await exists('MERGE_HEAD')     // stat #3
await exists('CHERRY_PICK_HEAD') // stat #4
await exists('REVERT_HEAD')    // stat #5
```

On Windows with Windows Defender enabled, each `stat()` triggers an AV intercept. 5 × 10–50 ms = 50–250 ms per change refresh.

**Fix:** Run all 5 checks in parallel with `Promise.all()`, then branch on results:

```typescript
const [hasMergeRebase, hasApplyRebase, hasMergeHead, hasCherryPick, hasRevert] =
  await Promise.all([
    exists('rebase-merge'),
    exists('rebase-apply'),
    exists('MERGE_HEAD'),
    exists('CHERRY_PICK_HEAD'),
    exists('REVERT_HEAD'),
  ]);
// Then: if (hasMergeRebase) { ... } else if (hasApplyRebase) { ... } ...
```

Happy path cost: 1 parallel round-trip instead of 5 serial ones.

---

### 3. `getConfiguration()` called on every gutter update (MEDIUM)
**File:** `src/editor/gutterDecorationController.ts` — `shouldSkipDocument()`

Previously called `vscode.workspace.getConfiguration('intelliGit')` + two `.get()` calls on every debounced gutter update (250 ms after each keystroke). This is a cache hit in VS Code, but still adds overhead when many editors are open.

**Fix:** Cache `maxLineCount` and `maxFileSizeKb` as class fields, initialised in constructor, updated only in `onDidChangeConfiguration`. The `onDidChangeConfiguration` scope was also broadened from `intelliGit.gutterMarkers.enabled` to `intelliGit.gutterMarkers` to catch size/line-count changes too.

```typescript
// Constructor
const cfg = vscode.workspace.getConfiguration('intelliGit');
this.maxLineCount = cfg.get<number>('gutterMarkers.maxLineCount', DEFAULT_GUTTER_MAX_LINE_COUNT);
this.maxFileSizeKb = cfg.get<number>('gutterMarkers.maxFileSizeKb', DEFAULT_GUTTER_MAX_FILE_SIZE_KB);
```

---

### 4. `onDidSaveTextDocument` had no debounce (LOW)
**File:** `src/extension.ts`

Format-on-save tools (Prettier, ESLint fix-on-save) trigger multiple rapid `onDidSaveTextDocument` events. Previously each triggered `stateStore.refreshChanges()` immediately.

**Fix:** Use `stateStore.requestRefresh(['changes'], { delayMs: 150 })` — coalesces saves within 150 ms.

---

## Why not all Windows machines are affected

| Factor | Machines NOT affected | Machines affected |
|---|---|---|
| Windows Defender | Excluded repo dir / disabled | Scanning all file access |
| Storage | NVMe SSD | HDD or network drive |
| Git size | Small repos | Many branches, large history |
| Worktrees/submodules | None | Multiple |
| Save tools | Plain save | Format-on-save + multiple formatters |

## Architecture notes

- `GitCommandQueue` concurrency: 2 on Windows, 4 on macOS/Linux (`process.platform === 'win32' ? 2 : 4`)
- `RefreshScheduler.request()` resets the debounce timer on each new call; only one `drain()` loop runs at a time — multiple overlapping events collapse to a single execution
- `getGitDir()` is cached in `_gitDirCache` after the first call — not re-run on every `getOperationState()` invocation
- `_gitRootCache` is similarly lazily cached in `getGitRoot()`

## Files changed in v0.15.4
- `src/state/stateStore.ts` — debounce worktree/submodule watcher callbacks
- `src/services/gitService.ts` — parallel `Promise.all` for `getOperationState` stat checks
- `src/editor/gutterDecorationController.ts` — cache config values; widen config-change scope
- `src/extension.ts` — debounce `onDidSaveTextDocument` refresh
