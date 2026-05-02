# Implementation Notes: Worktrees & Submodules Phase

**Author:** Senior Developer (Claude)
**Date:** 2026-05-02
**Branch:** `feature/worktrees-and-submodules`
**Status:** Implementation complete, pending Codex review

---

## What Was Implemented

### New Files Created

| File | Purpose |
|------|---------|
| `src/services/submoduleService.ts` | Submodule operations class + pure parser helpers |
| `src/providers/worktreeTreeProvider.ts` | Worktree tree view with 4 groups: Current / Other / Locked / Prunable |
| `src/providers/submoduleTreeProvider.ts` | Submodule tree view with 4 groups: Attention / Clean / Uninitialized / Nested |

### Modified Files

| File | Changes |
|------|---------|
| `src/types.ts` | Added `WorktreeEntry`, `WorktreeStatus`, `WorktreePruneEntry`, `SubmoduleEntry`, `SubmoduleConfigEntry`, `SubmoduleStatusEntry` |
| `src/services/gitService.ts` | Added 10 worktree methods, 13 submodule proxy methods, private `runGitAt`, lazy `submoduleSvc` getter, 2 exported parsers |
| `src/state/stateStore.ts` | Added `_worktrees`, `_submodules` state, `refreshWorktrees()`, `refreshSubmodules()`, FS watchers for `.git/worktrees/**`, `.git/modules/**`, `.gitmodules` |
| `src/commands/commandController.ts` | Added 14 worktree commands + 15 submodule commands + 6 Quick Action entries |
| `src/extension.ts` | Wired `WorktreeTreeProvider` and `SubmoduleTreeProvider`, registered `intelliGit.worktrees` and `intelliGit.submodules` views |
| `package.json` | Added 2 new views, 29 new commands, 6 view/title menus, 19 view/item/context menus, `intelliGit.hasSubmodules` context key |
| `src/test/gitParsing.test.ts` | Added fixture tests for worktree porcelain parser, prune dry-run parser, submodule config parser, submodule status parser |

---

## Architectural Decisions & Deviations from Plan

### 1. SubmoduleService as a Separate File

**Decision:** Submodule operations were implemented in a new `src/services/submoduleService.ts` rather than inline in `gitService.ts`.

**Reason:** The plan called for adding both worktree and submodule methods to `GitService`. However, during parallel agent implementation, separating the submodule methods into their own module avoided git merge conflicts. `GitService` now delegates to `SubmoduleService` via a lazily-instantiated private field (`submoduleSvc` getter), so the public API surface on `GitService` is identical to what the plan specified.

**Trade-off:** One extra file. The benefit is clear separation between worktree (in `GitService` directly) and submodule (delegated) concerns.

### 2. `viewItem` `when` Clauses Use `=~` Regex Matching

**Decision:** The context menus use `viewItem =~ /worktreeEntry/` instead of `viewItem == worktreeEntry`.

**Reason:** The plan specifies multiple context values per item (e.g., `worktreeEntry worktreeDirty`). VS Code's `=~` operator matches against a substring regex, enabling compound context values on a single item. This is standard VS Code extension practice.

### 3. `WorktreeEntry.isCurrent` Determined by Path Comparison

**Decision:** `isCurrent` is set to `true` when `worktreePath === this.gitRoot`.

**Reason:** `git worktree list --porcelain` does not output a `main worktree` marker — the main worktree is simply the first entry, and its path is the git root. This is reliable across Git versions.

**Caveat:** If the `gitRoot` cache hasn't been populated yet (before `getGitRoot()` is awaited during activation), the comparison falls back to `context.rootPath`, which is correct in the common case.

### 4. `refreshAll()` Safety — Worktree/Submodule Failures Don't Break Core State

**Decision:** Both `getWorktrees()` and `getSubmodules()` are called with `.catch(() => [])` in `refreshAll()`.

**Reason:** Repositories without worktrees or submodules return non-zero exit codes from some Git commands. The plan explicitly states: "StateStore.refreshAll() remains resilient when a repository has no worktrees beyond main or no submodules." The catch ensures the existing branch/stash/graph refresh is never blocked.

---

## Known Gaps / Items for Next Iteration

### 1. `compareWithCurrent` Command Not Implemented

The plan lists `intelliGit.worktree.compareWithCurrent`. This requires opening a diff between two working trees. The existing `editor.openBranchCompare` operates on branch refs, not filesystem paths. A dedicated implementation would need to either:
- Create temporary virtual documents for each worktree's files, or
- Use `git diff <worktree-branch>...<current-branch>` and display it.

**Recommendation:** Implement as a follow-up. Add `compareWithCurrent` to the command palette using the branch-based diff approach (compare `worktree.branch` against current branch).

### 2. `showPointerLog` Command Not Implemented

`intelliGit.submodule.showPointerLog` was in the plan but not in the MVP list. The underlying git command (`git log --oneline HEAD...FETCH_HEAD` inside the submodule) is straightforward. Skipped for MVP.

### 3. `absorbGitDirs` Command Not Implemented

`intelliGit.submodule.absorbGitDirs` (`git submodule absorbgitdirs`) was listed in the plan but not in the MVP. Low priority.

### 4. Ahead/Behind Not Populated for Submodules

`SubmoduleEntry.ahead` and `SubmoduleEntry.behind` are always `0`. Populating these would require running `git rev-list --count HEAD...FETCH_HEAD` inside each submodule, which is expensive. The plan mentions these fields but does not require them for MVP.

### 5. No E2E / Integration Tests

The plan calls for integration-level manual tests with temporary repositories. These cannot be automated in the current test setup (which only compiles). The fixture/unit tests for parsers are in place. Manual smoke tests should be performed by Codex before merging.

### 6. `intelliGit.hasSubmodules` Context Key Not Added to `package.json` `activationEvents` or `configuration`

The context key is set at runtime via `setContext`. It's used in some `view/title` `when` conditions. This is correct — no manifest registration needed.

---

## Verification Checklist (from Plan)

| Criterion | Status |
|-----------|--------|
| Worktree removal blocks dirty/current without force | ✅ Implemented with `confirmDangerousAction` |
| Worktree add validates before running Git | ✅ Input boxes with validation |
| Prune shows dry-run result first | ✅ `prunePreview` command |
| Submodule update/deinit warns on dirty | ✅ `confirmDangerousAction` guards |
| "checkout recorded" and "pull tracked" are separate commands | ✅ `checkoutRecorded` vs `pullTrackedBranch` |
| Pointer changes staged in superproject only | ✅ `stageSubmodulePointer` calls `git add` from repo root |
| Recursive operations preview affected count | ✅ `showInformationMessage` with count before `updateAll` |
| All parser helpers have fixture tests | ✅ 10 test cases in `gitParsing.test.ts` |
| `refreshAll()` resilient with no worktrees/submodules | ✅ `.catch(() => [])` fallbacks |
| Existing branch/stash/graph behavior unchanged | ✅ Only additive changes |
| `npm run compile` passes | ✅ Verified |
| README and command contributions are aligned | ⚠️ README not yet updated — awaiting Codex review |
