# Branch, Tag, and Git Graph Hover/Click Requirements

## Product Goal

Make the Branches, Tags, and Git Graph views feel predictable: clicking a row should perform the primary browsing action, while checkout and other state-changing commands stay in the context menu. Hover should reveal useful metadata through tooltips, not trailing action buttons that change the row layout.

## Current Problems

- Branch rows currently checkout immediately when clicked.
- Tag rows do not have a consistent default browsing action.
- Inline menu groups show trailing hover buttons such as "Checkout Branch", "Checkout", and "Open Commit Details".
- Branch and tag tooltips do not explain last update or comparison state clearly enough.

## Final Behaviors

- Branch click opens a custom webview table with commits reachable from that branch, capped by `intelliGit.maxGraphCommits`.
- Tag click opens a custom webview table with commits reachable from the tag target revision, capped by `intelliGit.maxGraphCommits`.
- Git Graph commit click keeps the VS Code tree default: expand or collapse the changed-file list.
- Checkout Branch, Checkout Tag, and Open Commit Details remain available from context menus, not as inline hover buttons.
- File-level inline actions, such as opening a changed-file diff, remain unchanged.

## Tooltip Contract

- Branch tooltip shows branch name, full ref, last update time, upstream when present, comparison ref, and ahead/behind counts.
- Local branches compare against their tracked upstream when present; otherwise they compare against a matching remote branch, preferring `origin/<branch>`.
- Remote branches compare against a matching local branch by short name.
- Tag tooltip shows tag name, full ref, target revision, last update time, and ahead/behind counts compared with the current local branch. Detached HEAD falls back to `HEAD`.
- Commit tooltip shows full SHA, subject, author, time, and refs.
- Missing comparison data is omitted rather than shown as a broken or unknown count.

## Implementation Tasks

- Add optional comparison metadata to branch and tag refs without replacing the existing `ahead` and `behind` fields.
- Add a reusable `git rev-list --left-right --count A...B` parser and comparison formatter with unit coverage.
- Populate branch and tag comparisons during Git state refresh.
- Route `BranchTreeItem.command` to `intelliGit.branch.openCommits`.
- Route `TagTreeItem.command` to `intelliGit.tag.openCommits`.
- Use the same commit filter contract and webview filter controls for Filter Graph, Branch commit lists, and Tag commit lists.
- Keep `GraphCommitTreeItem` command-free so tree expand/collapse remains the default click behavior.
- Move branch checkout, tag checkout, and graph open-details menu contributions out of the `inline` group.

## Test Plan

- Unit test branch tracking parse output.
- Unit test `rev-list --left-right --count` parse output.
- Unit test comparison summary formatting.
- Run `npm run check-types`.
- Run `npm run lint`.
- Run `npm test`.
- Before committing, run `gitnexus_detect_changes({scope: "all"})`.

## Open Notes

- Branch and tag commit-list tabs use the same custom commit-table webview filter controls as Filter Graph.
- Checkout remains intentionally available, but only through context menus and quick actions.
- GitNexus impact must be rerun after any later implementation changes if these symbols are touched again.
