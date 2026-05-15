# Features & Workflows

## Browse And Switch Branches

Open `Branches` to see local branches, remote branches, tags, and a Recent group. Branches are grouped by prefix such as `feature/*` and `release/*`.

Common actions are available from right-click menus and the Branch Action Hub:

- Checkout, create, rename, or delete branches.
- Track or untrack upstream branches.
- Merge a selected branch into the current branch.
- Rebase the current branch onto another branch.
- Reset the current branch to a selected commit with `soft`, `mixed`, or `hard` confirmation.
- Compare a branch with the current branch.
- Open branch or tag commits in `Git Graph`.
- Add, change, or set remote URLs with immediate update feedback.

Tags appear with branches and support checkout, checkout-new-branch, copy revision, repository-at-revision, compare-with-current, patch preview, and graph navigation actions.

## Inspect History And Commit Details

Open `Git Graph` for a tree-style commit list with refs, author/date metadata, subject-first titles, short hashes, and expandable changed files.

From a commit you can:

- Open `Commit Details` and immediately inspect changed files.
- Open file diffs against the commit parent.
- Checkout the commit in detached mode.
- Create a branch or tag at that commit.
- Cherry-pick, revert, create a patch, or compare with the current branch.
- Start an interactive rebase from the selected commit.
- Go to a parent or child commit.
- Multi-select commits with `Shift`, `Ctrl`, or `Cmd`; unsupported context-menu actions are disabled.

`Commit Details` also supports selected-file actions: revert selected changes, cherry-pick selected changes, and create a patch from selected file changes.

## Filter Commit History

Use `Filter Graph` from the Git Graph toolbar to narrow commits by:

- Branch or ref.
- Author.
- Message text.
- Since and until dates.

Filter fields apply as you type or change values. Selecting multiple commits in Filter Graph opens a merged Commit Details range that shows the net file changes across the selection.

## Compare Branches

Use `Compare Branches` when you need to understand what differs between two refs before merging, rebasing, or cherry-picking.

The comparison tab shows both directions (`A..B` and `B..A`) with commit and changed-file summaries. It supports:

- File-level diff drill-down.
- Multi-select commits with `Shift`, `Ctrl`, or `Cmd`.
- `Cmd/Ctrl+A` to select all visible commits in the active pane.
- `Esc` to clear selection.
- Merged Commit Details for a continuous selected range.
- Fuzzy message, author, exclude-message regex, and from/to date filters.
- Optional filters to ignore merge commits.
- Optional matching-message detection to hide likely cherry-picked commits across branches using author, timestamp, and message.
- Export as two CSV files or one Excel workbook with two sheets.
- Recent compare pairs persisted in workspace state.

## Compare A File Or Folder With A Revision

Right-click a file or folder in Explorer and choose `Compare with Revision`.

- Pick from local branches, remote branches, tags, or a typed commit SHA prefix.
- For a file, the diff opens with the selected revision on the left and the working tree on the right.
- For multiple selected files, the same revision is applied to every selected file and each diff opens.
- For a folder, `Commit Details` lists changed files and opens the first file in preview diff mode.

## Stash And Shelve Work

Open `Stashes` in the Source Control panel to manage saved work:

- Create a stash with optional untracked files and keep-index mode.
- Apply, pop, drop, rename, preview patch, or unshelve a stash.
- Right-click an unstaged SCM resource and choose the shelve action to stash only that file.

## Resolve Conflicts

For merge, rebase, cherry-pick, and revert flows, the extension keeps the operation visible:

- Conflict files open in VS Code merge editors when possible.
- If files cannot be opened directly, the Source Control view is revealed as a fallback.
- Status-bar actions expose `Continue`, `Skip`, and `Abort` when those actions apply.
- Rebase progress is shown when Git exposes the current step.
- Finalize commands guard against unresolved conflicts.

## Manage Worktrees

Open `Worktrees` to manage parallel checkouts from the Activity Bar container.

Worktrees are grouped as `Current`, `Other Worktrees`, `Locked`, and `Prunable / Stale`.

Available actions include:

- Open a worktree in this window or a new window.
- Reveal in Finder / Explorer.
- Open a terminal in the worktree directory.
- Add a worktree from an existing branch.
- Add a worktree with a new branch.
- Add a detached worktree.
- Lock, unlock, remove, or force remove worktrees.
- Preview and prune stale worktrees.

## Manage Submodules

Open `Submodules` to inspect nested repositories.

Submodules are grouped as `Needs Attention`, `Clean`, `Uninitialized`, and `Nested`.

Available actions include:

- Init one submodule or all submodules.
- Update one submodule, update all, or update recursively.
- Sync one URL or all URLs.
- Open a submodule in this window or a new window.
- Checkout the recorded commit when the pointer is out of sync.
- Pull the tracked branch.
- Show pointer diff.
- Stage pointer change.
- Deinit a submodule.

## Commit From Source Control

The extension adds daily commit helpers to VS Code's native Source Control panel:

- Pick a reusable commit message template.
- Generate a commit message from staged diff with a configurable timeout.
- Amend the last commit from the SCM input box.
- Commit with `Ctrl+Enter` / `Cmd+Enter`.
- Stage or unstage files, run partial staging, and fetch/push/pull with previews.
