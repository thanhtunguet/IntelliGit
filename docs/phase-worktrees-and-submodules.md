# Phase: Worktrees and Submodules

## Product Goal

Make IntelliGit a first-class workspace manager for advanced Git repositories, not only a branch/stash/graph client.

This phase targets two Git areas that are still awkward in most IDEs:

- Worktrees: run multiple branches or commits side by side without constantly stashing, checking out, or disrupting the current workspace.
- Submodules: make nested repositories visible, explain their state, and provide guarded flows for update, sync, diff, and pointer changes.

The product bar is higher than basic command wrappers. The UI must explain what is happening, prevent dangerous mistakes, and keep Git state refreshes deterministic.

## Current Architecture Fit

Use the existing extension shape:

- `GitService`: add typed Git CLI operations and parsing helpers.
- `StateStore`: cache worktree and submodule state, refresh it alongside branches, stashes, graph, and changes.
- `providers/*TreeProvider.ts`: add dedicated tree providers for the new views.
- `CommandController`: register commands, pickers, destructive-operation confirmations, and refresh orchestration.
- `package.json`: contribute views, commands, menus, and context keys.
- `README.md`: document implemented behavior after the phase is complete.

Do not fold these features into the existing branch or stash providers. They are related, but they deserve separate views and command groups.

## Feature 1: Worktree Manager

### User Outcomes

- See every worktree attached to the repository.
- Know which path, branch, commit, and dirty state each worktree has.
- Open a worktree quickly in VS Code.
- Create a worktree from an existing branch, new branch, tag, or commit.
- Remove or prune worktrees with strong safety checks.
- Compare the current workspace against another worktree.

### View

Add a new `intelliGit.worktrees` tree view under the IntelliGit activity bar.

Each worktree item should show:

- Worktree path, preferably shortened relative to the parent directory when possible.
- Current branch, detached HEAD, or bare marker.
- Current worktree marker.
- Dirty/clean state.
- Ahead/behind state when an upstream exists.
- Locked, prunable, or stale status.
- Short HEAD SHA and latest subject in tooltip.

Suggested grouping:

- Current
- Other Worktrees
- Locked
- Prunable or Stale

### Commands

Add command IDs under `intelliGit.worktree.*`:

- `list` or implicit refresh through the view.
- `open`
- `openInNewWindow`
- `addFromBranch`
- `addNewBranch`
- `addDetached`
- `remove`
- `removeForce`
- `lock`
- `unlock`
- `prunePreview`
- `prune`
- `compareWithCurrent`
- `revealInFinder`
- `openTerminal`

The MVP can ship with:

- List worktrees.
- Open worktree.
- Add from existing branch.
- Add new branch from a selected base.
- Add detached worktree at a selected commit/ref.
- Remove guarded.
- Prune with preview.

### GitService Work

Add typed methods:

- `getWorktrees(): Promise<WorktreeEntry[]>`
- `addWorktree(path: string, ref: string): Promise<void>`
- `addWorktreeBranch(path: string, branch: string, base?: string): Promise<void>`
- `addDetachedWorktree(path: string, ref: string): Promise<void>`
- `removeWorktree(path: string, force?: boolean): Promise<void>`
- `lockWorktree(path: string, reason?: string): Promise<void>`
- `unlockWorktree(path: string): Promise<void>`
- `getPrunableWorktrees(): Promise<WorktreePruneEntry[]>`
- `pruneWorktrees(): Promise<void>`
- `getWorktreeStatus(path: string): Promise<WorktreeStatus>`

Use:

- `git worktree list --porcelain -z`
- `git worktree add`
- `git worktree add -b`
- `git worktree add --detach`
- `git worktree remove`
- `git worktree lock`
- `git worktree unlock`
- `git worktree prune --dry-run`
- `git -C <path> status --porcelain=v1 --branch`
- `git -C <path> log -1 --format=...`

Parsing must be isolated in pure helpers so fixture tests can cover edge cases.

### Safety Rules

- Never remove a dirty worktree without modal confirmation.
- Never force-remove unless the user explicitly chooses a force action.
- Never remove the main/current worktree.
- Warn when a branch is already checked out in another worktree.
- Validate target path before running `git worktree add`.
- Treat detached worktree operations as potentially destructive and label them clearly.
- Show a dry-run result before pruning.

## Feature 2: Submodule Manager

### User Outcomes

- See all submodules, including nested submodules.
- Know whether each submodule is initialized, clean, dirty, detached, behind, ahead, or mismatched from the recorded superproject pointer.
- Initialize, update, sync, and open submodules without remembering command syntax.
- Understand pointer changes before staging them.
- Avoid accidental updates that rewrite expected submodule commits.

### View

Add a new `intelliGit.submodules` tree view under the IntelliGit activity bar.

Each submodule item should show:

- Path.
- Name from `.gitmodules`.
- URL.
- Initialized/uninitialized state.
- Current HEAD SHA.
- Recorded superproject SHA.
- Branch tracking value when configured.
- Dirty/clean state.
- Ahead/behind state when upstream exists.
- Mismatch marker when current HEAD differs from recorded SHA.

Suggested grouping:

- Needs Attention
- Clean
- Uninitialized
- Nested

### Commands

Add command IDs under `intelliGit.submodule.*`:

- `init`
- `initAll`
- `update`
- `updateAll`
- `updateRecursive`
- `sync`
- `syncAll`
- `open`
- `openInNewWindow`
- `checkoutRecorded`
- `pullTrackedBranch`
- `diffPointer`
- `showPointerLog`
- `stagePointerChange`
- `deinit`
- `absorbGitDirs`

The MVP can ship with:

- List submodules recursively.
- Init selected/all.
- Update selected/all.
- Sync selected/all.
- Open selected submodule.
- Show dirty, uninitialized, and pointer mismatch state.
- Diff pointer and stage pointer change.

### GitService Work

Add typed methods:

- `getSubmodules(): Promise<SubmoduleEntry[]>`
- `getSubmoduleConfig(): Promise<SubmoduleConfigEntry[]>`
- `getSubmoduleStatus(recursive?: boolean): Promise<SubmoduleStatusEntry[]>`
- `initSubmodule(path: string): Promise<void>`
- `updateSubmodule(path: string, recursive?: boolean): Promise<void>`
- `syncSubmodule(path?: string, recursive?: boolean): Promise<void>`
- `deinitSubmodule(path: string, force?: boolean): Promise<void>`
- `checkoutRecordedSubmoduleCommit(path: string): Promise<void>`
- `pullSubmoduleTrackedBranch(path: string): Promise<void>`
- `getSubmodulePointerDiff(path: string): Promise<string>`
- `stageSubmodulePointer(path: string): Promise<void>`

Use:

- `git submodule status --recursive`
- `git config --file .gitmodules --get-regexp`
- `git submodule update --init --recursive`
- `git submodule sync --recursive`
- `git submodule deinit`
- `git diff --submodule=log -- <path>`
- `git ls-files -s -- <path>`
- `git -C <path> status --porcelain=v1 --branch`
- `git -C <path> rev-parse HEAD`

Prefer Git's structured command output where possible. Avoid manually parsing `.gitmodules` as raw text unless Git config output is insufficient.

### Safety Rules

- Block or strongly warn before update/deinit if a submodule has dirty changes.
- Keep "checkout recorded commit" separate from "pull latest tracked branch".
- Explain when an action changes only the submodule working tree versus when it stages a pointer change in the superproject.
- Stage pointer changes only from the superproject.
- For recursive operations, show the affected submodule count before running.
- Do not assume every submodule has a branch configured.

## Shared Implementation Tasks

### Types

Add new interfaces in `src/types.ts`:

- `WorktreeEntry`
- `WorktreeStatus`
- `WorktreePruneEntry`
- `SubmoduleEntry`
- `SubmoduleConfigEntry`
- `SubmoduleStatusEntry`
- `RepositoryAttentionItem` if both views need shared warning metadata.

### State

Extend `StateStore`:

- `_worktrees`
- `_submodules`
- `worktrees` getter
- `submodules` getter
- `refreshWorktrees()`
- `refreshSubmodules()`
- Include both in `refreshAll()`.

Extend auto-refresh watchers:

- `.git/worktrees/**`
- `.git/modules/**`
- `.gitmodules`

Also refresh on window focus, matching the existing fallback strategy.

### Providers

Add:

- `src/providers/worktreeTreeProvider.ts`
- `src/providers/submoduleTreeProvider.ts`

Provider item context values should be specific enough for menus:

- `worktreeEntry`
- `worktreeCurrent`
- `worktreeDirty`
- `worktreeLocked`
- `submoduleEntry`
- `submoduleDirty`
- `submoduleUninitialized`
- `submodulePointerChanged`

### Commands and Menus

Extend `CommandController.register()` with the new command groups.

Add Quick Actions entries:

- Open worktree manager.
- Add worktree.
- Prune worktrees.
- Init/update submodules.
- Sync submodules.

Add `package.json` contributions:

- Views.
- Commands.
- View title buttons.
- View item context menus.
- Optional context keys such as `intelliGit.hasSubmodules`.

### Documentation

After implementation, update:

- `README.md` implemented features.
- `ROADMAP.md` if this phase moves from planned to implemented.
- `CHANGELOG.md` for user-visible additions.

## Testing Plan

### Parser Tests

Add fixture-style tests for:

- `git worktree list --porcelain -z`.
- Locked worktree output.
- Prunable worktree dry-run output.
- Detached worktree output.
- Branch already checked out elsewhere.
- `git submodule status --recursive`.
- Uninitialized submodule.
- Dirty submodule.
- Nested submodule.
- `.gitmodules` config output.
- Pointer mismatch between recorded SHA and current HEAD.

### Integration-Level Manual Tests

Use temporary local repositories:

- Repo with two normal branches and two worktrees.
- Repo with one locked worktree.
- Repo with stale/prunable worktree metadata.
- Repo with one submodule.
- Repo with nested submodule.
- Repo with dirty submodule.
- Repo where submodule HEAD differs from recorded pointer.

### Required Verification Commands

At minimum:

```bash
npm run compile
```

If parser tests are added under the existing test setup, keep:

```bash
npm run test
```

## Suggested Ownership Split

### Worker A: Worktree Data Layer

Owns:

- Types.
- `GitService` worktree methods.
- Worktree parser tests.

Must not edit:

- Submodule provider.
- Submodule commands.

### Worker B: Worktree UI and Commands

Owns:

- Worktree tree provider.
- Worktree command registration.
- `package.json` worktree contributions.
- README updates for worktrees.

Depends on Worker A method names and types.

### Worker C: Submodule Data Layer

Owns:

- Types.
- `GitService` submodule methods.
- Submodule parser tests.

Must not edit:

- Worktree provider.
- Worktree commands.

### Worker D: Submodule UI and Commands

Owns:

- Submodule tree provider.
- Submodule command registration.
- `package.json` submodule contributions.
- README updates for submodules.

Depends on Worker C method names and types.

### Integrator

Owns:

- `StateStore` integration.
- `extension.ts` provider wiring.
- Cross-view refresh behavior.
- Final compile and manual smoke test.

## Review Checklist

Use this checklist before merging the phase.

- Worktree removal blocks dirty/current worktrees unless the user explicitly confirms a safe force path.
- Worktree add validates branch/path conflicts before running Git.
- Prune shows dry-run output first.
- Submodule update/deinit warns on dirty submodules.
- Submodule "checkout recorded commit" and "pull tracked branch" are separate commands.
- Pointer changes are staged in the superproject only.
- Recursive submodule commands preview affected count.
- All parser helpers have fixture tests.
- `StateStore.refreshAll()` remains resilient when a repository has no worktrees beyond main or no submodules.
- Existing branch/stash/graph behavior is unchanged.
- `npm run compile` passes.
- README and command contributions are aligned.

## Recommended Delivery Order

1. Worktree data layer.
2. Worktree view and commands.
3. Submodule data layer.
4. Submodule view and commands.
5. Shared polish: quick actions, docs, refresh watchers, final smoke test.

This order gives users a valuable feature early while keeping submodule risk isolated until the worktree foundation is stable.
