# Compare with Revision — Design

**Status:** Approved for implementation
**Date:** 2026-05-03
**Owner:** thanhtung.uet@gmail.com

## Summary

Add an Explorer context-menu action that lets the user compare any file or folder in the workspace against the same path at another Git revision (branch, tag, or commit). For a file, the action opens a diff editor; for a folder, it lists changed files in the existing Commit Details view and opens the first file's diff in a preview tab that is reused as the user clicks through the list.

## Goals

- Right-click a file or folder in the Explorer and compare it to its counterpart at any branch, tag, or commit, including arbitrary commit SHAs entered by hand.
- Diff editor convention: **left = revision X, right = working tree** (matches `git diff X` and the rest of the codebase).
- For folders, surface the changed-files list in the existing Commit Details view; clicking files reuses one preview diff tab instead of accumulating tabs.
- Use a picker UI styled after VS Code's "Select branch or tag to checkout" — local branches, remote branches, and tags grouped with type icons; commit SHAs reachable by typing in the input field.

## Non-Goals

- Remembering recent comparisons or per-file/per-folder ref history.
- A toggle to flip the diff direction.
- Submodule traversal beyond what `repositoryContext` already resolves.
- Working-tree-vs-revision comparison entry points outside the Explorer (palette, SCM view, status bar).

## User Flow

1. User right-clicks a file or folder in the Explorer.
2. The menu shows **"Compare with Revision…"** in `navigation@10`, just below the existing `intelliGit.fileHistory.open`.
3. A `QuickPick` opens, modeled on VS Code's checkout picker:
   - Section separators for **Local branches**, **Remote branches**, **Tags**.
   - Each item is prefixed with a type icon (`$(git-branch)`, `$(cloud)`, `$(tag)`) and a short description (upstream hint, short SHA, etc.).
   - Fuzzy-filter operates over labels.
   - **Commit-SHA dynamic lookup:** when the typed input matches `^[0-9a-f]{4,40}$`, the picker resolves it via `git rev-parse --verify <input>^{commit}`. On success, a synthetic `$(git-commit)` item is prepended to the list (label = short SHA, description = subject + author + date) and is selectable.
   - No exclusions: even if the chosen ref resolves to the same SHA as `HEAD`, the diff still runs (the working tree may differ from `HEAD`, so an empty diff is acceptable feedback).
4. On selection, the resolved ref becomes `revisionX`. The diff convention is fixed: **left = revisionX, right = working tree**.
5. **File target:** open a diff editor (`vscode.diff`) with the virtual `intelligit:` URI for `revisionX` on the left and the working-tree `file://` URI on the right. `preview: false` so the file diff stays open as a normal tab.
6. **Folder target:** activate the Commit Details view in a new "working-tree-compare" mode, populate it with the files inside the folder that differ between the working tree and `revisionX`, and auto-open the first file's diff with `preview: true`. Subsequent clicks on tree items reuse the same preview tab.

## Architecture

### New files

- `src/views/revisionPicker.ts`
  - Exports `pickRevisionToCompare(git: GitService): Promise<RevisionSelection | undefined>`.
  - Owns the QuickPick lifecycle, section grouping (local / remote / tag), the dynamic SHA-lookup behavior, and the busy indicator.
  - Returns `{ ref: string; label: string; kind: 'branch' | 'remote' | 'tag' | 'commit' } | undefined`.

### Modified files

- `src/services/gitService.ts`
  - `getFilesChangedBetweenWorkingTreeAndRef(ref: string, scopePath?: string): Promise<FileChange[]>`
    - Tracked changes: `git diff --name-status -z [-- <scope>] <ref>`.
    - Untracked files in scope: `git ls-files --others --exclude-standard -z [-- <scope>]`, reported as status `A` with an "untracked" marker so the tree row can hint the source.
    - Statuses parsed: `M` modified, `A` added, `D` deleted, `R` rename, `C` copy.
  - `resolveRevisionToCommit(input: string): Promise<{ sha: string; subject: string; author: string; date: string } | undefined>`
    - Wraps `git rev-parse --verify <input>^{commit}` followed by a one-line `git log` lookup for metadata.
    - Returns `undefined` on any failure; never throws to the picker.
  - `getWorkingTreeFileUri(relativePath: string): vscode.Uri` — small helper returning `Uri.file(path.join(repoRoot, relativePath))`. Add only if no equivalent already exists.

- `src/editor/editorOrchestrator.ts`
  - `openCompareWithRevisionForFile(relativePath: string, ref: string, refLabel: string): Promise<void>`
    - Builds the virtual `intelligit:` URI for `(ref, relativePath)` via `createVirtualUri`.
    - Right side: working-tree `file://` URI.
    - `vscode.diff(left, right, "<refLabel> ↔ working tree · <relativePath>", { preview: false, preserveFocus: false })`.
  - `openCompareWithRevisionForFolder(folderRelPath: string, ref: string, refLabel: string): Promise<void>`
    - Calls `gitService.getFilesChangedBetweenWorkingTreeAndRef(ref, folderRelPath)`.
    - If the result is empty: `showInformationMessage("No differences in <folder> against <refLabel>")` and return without changing the view.
    - Otherwise: `commitFilesTreeProvider.showWorkingTreeComparison({ ref, refLabel, scopePath: folderRelPath, files })`, then `openWorkingTreeFileDiff(files[0].path, ref, { preview: true })`.
  - `openWorkingTreeFileDiff(relativePath: string, ref: string, opts: { preview: boolean }): Promise<void>`
    - Same diff invocation as the file case, but `preview` is parameterized so the folder mode can pass `true` and reuse a single tab.

- `src/providers/commitFilesTreeProvider.ts`
  - Introduce a `mode` discriminator alongside the existing commit/revision modes: `'commit' | 'revision' | 'workingTreeCompare'`.
  - Add `showWorkingTreeComparison({ ref, refLabel, scopePath, files })` that swaps the data source and updates the view title to `Working tree ↔ <refLabel> · <scopePath>`.
  - The node-click handler dispatches by mode: in `workingTreeCompare`, it calls `editorOrchestrator.openWorkingTreeFileDiff(file.path, ref, { preview: true })` instead of the existing commit-file-diff path. Existing modes are unchanged.
  - Untracked items render with an "untracked" description so the user understands why a file with no commit history appears in the list.

- `src/commands/commandController.ts`
  - Register `intelliGit.compareWithRevision`. The handler:
    1. Coerces the argument to a `vscode.Uri` (Explorer context provides one).
    2. Resolves the repo via the existing `repositoryContext` helper; surfaces `"Not inside a Git repository"` if it fails.
    3. Computes the repo-relative path and uses `vscode.workspace.fs.stat` to determine file vs directory.
    4. Calls `pickRevisionToCompare(git)`.
    5. Dispatches to `editorOrchestrator.openCompareWithRevisionForFile` or `…ForFolder`.

- `package.json`
  - New command contribution `intelliGit.compareWithRevision` titled **"Compare with Revision…"**.
  - New `explorer/context` entry: `when: "resourceScheme == file"`, `group: "navigation@10"` (covers files and folders).
  - `commandPalette` entry with `when: false` to hide it from the palette, matching the `fileHistory.open` precedent.

## Data Flow

**File compare**

```
Explorer right-click (Uri)
  → commandController: intelliGit.compareWithRevision
  → repositoryContext.resolveRepoForUri → repoRoot, relativePath
  → workspace.fs.stat → isFile
  → revisionPicker.pickRevisionToCompare(git) → { ref, label }
  → editorOrchestrator.openCompareWithRevisionForFile(relativePath, ref, label)
       ├── createVirtualUri(ref, relativePath)               // left
       ├── workingTreeUri = Uri.file(repoRoot/relativePath)  // right
       └── vscode.diff(left, right, "<label> ↔ working tree · <path>", { preview: false })
```

**Folder compare**

```
… same up through pickRevisionToCompare, then isDirectory branch:
  → editorOrchestrator.openCompareWithRevisionForFolder(folderRel, ref, label)
       ├── git.getFilesChangedBetweenWorkingTreeAndRef(ref, folderRel)
       │     ├── git diff --name-status -z <ref> -- <folderRel>             # tracked
       │     └── git ls-files --others --exclude-standard -z -- <folderRel> # untracked
       ├── if files.length === 0 → showInformationMessage; return
       ├── commitFilesView.showWorkingTreeComparison({ ref, refLabel, scopePath, files })
       │     └── tree refresh + focus Commit Details view
       └── editorOrchestrator.openWorkingTreeFileDiff(files[0].path, ref, { preview: true })

User clicks another file in Commit Details view:
  → CommitFilesTreeProvider node command (mode-aware dispatcher)
  → editorOrchestrator.openWorkingTreeFileDiff(file.path, ref, { preview: true })
  → vscode.diff replaces the existing preview tab in place
```

**Picker dynamic SHA lookup**

```
QuickPick.onDidChangeValue(input):
  if /^[0-9a-f]{4,40}$/.test(input):
    debounce 150ms
    quickPick.busy = true
    → git.resolveRevisionToCommit(input)
    → on success: prepend synthetic { kind: 'commit', ref: sha, label: short(sha), description: subject … } to items
    → on failure / cancellation: remove synthetic item
    quickPick.busy = false
```

## Error Handling

| Condition | Behavior |
|---|---|
| Right-click target outside any repo | `showErrorMessage("Not inside a Git repository")`. Picker does not open. |
| Picker shows but no branches/tags exist | Picker shows with placeholder `"Type a commit SHA to compare against…"`. Empty selection cancels silently. |
| User picks a ref that no longer exists by the time we resolve (race) | Caught in `openCompareWithRevisionForFile/Folder`, surfaced as an error toast, command aborts. |
| File does not exist at revision X (added since) | `getFileContentFromRef` returns empty; left side empty, right side shows the file. Diff renders as full-add. (Existing pattern.) |
| File deleted in working tree (exists at X) | Right side reads `''`; diff renders as full-delete. |
| Folder does not exist at revision X | All current files in the folder show as added; that is correct semantics. |
| `git diff` errors (corrupt repo, etc.) | Caught at command level, surfaced via `showErrorMessage`. |
| Untracked file inside scope | Listed with status `A` and an "Untracked" hint in the tree item description. |
| User cancels picker | Silent return, no view changes, no toast. |

## Testing

`src/test/` runs Node's built-in test runner against compiled output. New tests:

- `revisionPicker.test.ts` — unit-test the SHA-pattern detection and synthetic-item assembly with a mocked `GitService`. Pure logic; no VS Code UI required.
- `gitService.workingTreeDiff.test.ts` — fixture-repo integration test: create a temp repo, commit a file, modify it in the working tree, add an untracked file, then assert `getFilesChangedBetweenWorkingTreeAndRef(HEAD, '.')` returns `[modified, untracked]`. Repeat for a sub-folder scope. Reuse the existing fixture-repo helper if one exists; otherwise add a minimal one alongside.
- **Manual test plan** to run before merging:
  1. Right-click a tracked, modified file → "Compare with Revision…" → pick `HEAD` → diff opens, shows working-tree vs `HEAD` differences.
  2. Right-click the same file → pick a tag → diff opens against the tag.
  3. Type a 7-char commit prefix in the picker → synthetic commit item appears → select it → diff opens.
  4. Right-click a folder containing modified + untracked + unchanged files → Commit Details view opens with only the modified + untracked rows; first file's diff is open in preview.
  5. Click subsequent files in the Commit Details view → the same preview tab updates in place.
  6. Right-click a folder with no diffs against the chosen ref → info message; no view change.
  7. Right-click a path outside any Git repo → error toast; picker does not open.
  8. Cancel the picker (Esc) → no view or editor side effects.

## Documentation Updates

- `README.md` — add "Compare with Revision" to the feature list and Explorer context-menu section.
- `CHANGELOG.md` — entry under the next minor-version section describing the new context-menu action and folder mode.
- `docs/` — release-notes file for the cutting version once the change is shipped.

## Open Questions

None at design-approval time.
