# IntelliGit Roadmap

Features from the IntelliJ Git client that are not yet implemented.

---

## Daily Workflow

### Smart Changelists
Group unrelated local changes into separate named buckets before committing. Each changelist can be committed independently, keeping unrelated edits from leaking into the same commit.

### Commit Message Templates
Define reusable message templates (e.g., conventional commit prefixes, ticket number patterns) that pre-populate the commit input in the Changes panel.

---

## Remote and Collaboration

### Pull Request Workflows (GitHub / GitLab)
Review, comment on, and approve pull requests directly in the IDE without leaving VS Code. Includes:
- PR list view in the sidebar
- Inline diff comments
- Approve / request changes / merge actions

### Issue / Task Integration
Link commits and branches to issue IDs from GitHub Issues, GitLab Issues, or Jira. Includes:
- Branch name suggestions from open issues
- Commit message pre-population with issue references
- Status transitions on push

---

## Quality and Safety Nets

### Pre-commit Checks
Run user-defined shell commands (linters, formatters, test suites) before a commit is finalized. Block the commit and surface failures in the Changes panel if checks fail.

### Local History
Maintain an IDE-level snapshot history of files independent of Git commits, providing a safety net for changes that were never staged or committed.

---

## Phase: Last (High Complexity, Deep IDE Integration)

These features are technically possible in the VS Code extension model but require significant custom infrastructure and are deferred to the final phase.

### Code-Aware Diff Context
Syntax-level diff rendering that understands language structure — highlighting moved blocks, renamed symbols, and refactored code as semantic changes rather than raw line deltas. Requires a custom `CustomEditorProvider`-based diff view wired to Language Server semantic tokens.

### Unified Refactoring + Git Loop
Respond to IDE rename/refactor operations (via `workspace.onWillRenameFiles` / `onDidRenameFiles`) to automatically suggest Git actions — e.g., pre-populate commit messages referencing the renamed symbol, or suggest branch renames. Requires deep integration with LSP rename flows.
