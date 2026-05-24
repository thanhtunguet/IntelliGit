# Commit Changes Context Menu Behaviors

This extension shows commit details as a tree view in the following places:

- Git Graph Commit Expansion
- Filter Graph
- Compare Branches

When a user clicks a commit in any of these views, commit details are shown in the side panel.
This behavior should be consolidated across all entry points:

- Clicking a commit shows its details in the side panel.
- Clicking the same commit again hides the side panel.
- Clicking a different commit updates the side panel with that commit's details.
- Users can select multiple changes in the commit details view and run actions on them.

## Commit Details Context Menu

When a user right-clicks selected changes in the commit details view, show a context menu with these actions:

- Open Diffs (previously: "Open commit file diffs"): Applies to selected files (including multi-select) and is the default action when a user clicks a file.
- Revert Selected Changes: Enabled only when the commit exists in the current working tree/current branch/current revision; otherwise disabled.
- Cherry-pick Selected Changes: Enabled only when the commit does not exist in the current working tree/current branch/current revision; otherwise disabled.
- Create Patch: Creates a patch (saved to file or copied to clipboard) from selected changes and reapplies it to current state, only when the commit is not present in the current working tree/current branch/current revision.

## Identify Whether a Commit Is in the Current Branch/Revision/Working Tree

Identify commits by commit ID.
Even if the current branch contains the same patch because it was cherry-picked, treat it as a different commit.
If the changes already exist in current state, show an IntelliJ-like message: "Nothing to cherry pick".

## New Feature: Create Patch / Apply Patch

Use the sample patch file created by IntelliJ: `@unnamed.patch`.

It is a text file generated from changed files in one commit or multiple commits.
Users should be able to select multiple changes from a commit (and later from multiple commits) and apply them when needed.
The current sample file covers only text-based changes.
Research how IntelliJ creates patches for binary files (images, binaries, etc.).
If no reliable information is found about IntelliJ handling for binary files, document this limitation and implement text-only handling.

- In this phase, implement "Create Patch" for selected changes in Commit Details first. Support applying across multiple commits in the next phase.
- Add "Apply Patch" as a VS Code command (via `Cmd + Shift + P`) that lets users choose patch input from clipboard or file, then apply it to the current working tree only when the tree is clean or patchable.
