import * as vscode from 'vscode';
import type { GitService } from '../services/gitService';
import type { BranchRef, TagRef } from '../types';

// ── Exported types ────────────────────────────────────────────────────────────

export type RevisionKind = 'branch' | 'remote' | 'tag' | 'commit';

export interface RevisionSelection {
  readonly ref: string;
  readonly label: string;
  readonly kind: RevisionKind;
}

// ── Internal QuickPick item shape ─────────────────────────────────────────────

interface RevisionPickerItem extends vscode.QuickPickItem {
  readonly revision?: RevisionSelection;
}

// ── Pure helpers (exported for testing) ──────────────────────────────────────

/**
 * Returns true when `input` looks like a partial or full Git SHA (4–40 lowercase hex chars).
 */
export function isLikelyShaPrefix(input: string): boolean {
  return /^[0-9a-f]{4,40}$/.test(input);
}

/**
 * Builds sectioned QuickPick items from branch and tag arrays.
 * Emits a separator + items for each non-empty group in order:
 *   1. Local branches
 *   2. Remote branches
 *   3. Tags
 */
export function buildRevisionPickerItems(
  branches: readonly BranchRef[],
  tags: readonly TagRef[]
): RevisionPickerItem[] {
  const items: RevisionPickerItem[] = [];

  const localBranches = branches.filter((b) => b.type === 'local');
  const remoteBranches = branches.filter((b) => b.type === 'remote');

  if (localBranches.length > 0) {
    items.push({ label: 'Local branches', kind: vscode.QuickPickItemKind.Separator } as RevisionPickerItem);
    for (const branch of localBranches) {
      items.push({
        label: `$(git-branch) ${branch.name}`,
        description: branch.current ? '(current)' : undefined,
        revision: { ref: branch.name, label: branch.name, kind: 'branch' }
      });
    }
  }

  if (remoteBranches.length > 0) {
    items.push({ label: 'Remote branches', kind: vscode.QuickPickItemKind.Separator } as RevisionPickerItem);
    for (const branch of remoteBranches) {
      items.push({
        label: `$(cloud) ${branch.name}`,
        revision: { ref: branch.name, label: branch.name, kind: 'remote' }
      });
    }
  }

  if (tags.length > 0) {
    items.push({ label: 'Tags', kind: vscode.QuickPickItemKind.Separator } as RevisionPickerItem);
    for (const tag of tags) {
      items.push({
        label: `$(tag) ${tag.name}`,
        revision: { ref: tag.name, label: tag.name, kind: 'tag' }
      });
    }
  }

  return items;
}

// ── Minimal git interface (avoids importing full GitService in tests) ──────────

export interface RevisionResolver {
  resolveRevisionToCommit(input: string): Promise<{ sha: string; subject: string; author: string; date: string } | undefined>;
}

// ── pickRevisionToCompare ─────────────────────────────────────────────────────

/**
 * Presents a sectioned QuickPick for choosing a revision to compare against.
 * When the user types a SHA prefix (4–40 hex chars), the picker debounces
 * 150 ms and then calls `git.resolveRevisionToCommit` to prepend a synthetic
 * commit item at the top of the list.
 *
 * Returns the selected `RevisionSelection` or `undefined` if the user cancelled.
 */
export async function pickRevisionToCompare(
  git: GitService,
  getBranches: () => readonly BranchRef[],
  getTags: () => readonly TagRef[],
  onRefresh: () => Promise<void>
): Promise<RevisionSelection | undefined> {
  return new Promise<RevisionSelection | undefined>((resolve) => {
    let resolved = false;
    let disposed = false;

    const settle = (value: RevisionSelection | undefined): void => {
      if (resolved) {
        return;
      }
      resolved = true;
      resolve(value);
    };

    const qp = vscode.window.createQuickPick<RevisionPickerItem>();
    qp.placeholder = 'Select a branch, tag, or type a commit SHA…';
    qp.matchOnDescription = true;
    const refreshButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon('refresh'),
      tooltip: 'Refresh branches and tags'
    };
    qp.buttons = [refreshButton];

    let baseItems = buildRevisionPickerItems(getBranches(), getTags());
    qp.items = baseItems;

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let lookupSeq = 0;
    let syntheticItem: RevisionPickerItem | undefined;
    let refreshing = false;

    const applyBaseItems = () => {
      baseItems = buildRevisionPickerItems(getBranches(), getTags());
      qp.items = syntheticItem ? [syntheticItem, ...baseItems] : baseItems;
    };

    const refreshItems = (placeholder: string): void => {
      if (refreshing) {
        return;
      }
      refreshing = true;
      qp.busy = true;
      qp.placeholder = placeholder;
      void onRefresh()
        .then(() => {
          if (disposed) {
            return;
          }
          applyBaseItems();
          qp.placeholder = baseItems.length > 0
            ? 'Select a branch, tag, or type a commit SHA…'
            : 'No branches found — type a commit SHA';
        })
        .catch(() => {
          if (!disposed) {
            qp.placeholder = 'Failed to load branches and tags';
          }
        })
        .finally(() => {
          refreshing = false;
          if (!disposed) {
            qp.busy = false;
          }
        });
    };

    const clearSynthetic = () => {
      if (syntheticItem) {
        syntheticItem = undefined;
        qp.items = baseItems;
      }
    };

    qp.onDidChangeValue((value) => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }

      const trimmed = value.trim().toLowerCase();
      if (!isLikelyShaPrefix(trimmed)) {
        clearSynthetic();
        qp.busy = false;
        return;
      }

      const seq = ++lookupSeq;
      qp.busy = true;

      debounceTimer = setTimeout(async () => {
        try {
          const meta = await git.resolveRevisionToCommit(trimmed);
          if (seq !== lookupSeq) {
            return; // stale lookup — a newer input has superseded this one
          }
          if (meta) {
            const shortSha = meta.sha.slice(0, 7);
            syntheticItem = {
              label: `$(git-commit) ${shortSha}`,
              description: meta.subject,
              detail: `${meta.author}  ${meta.date}`,
              revision: { ref: meta.sha, label: shortSha, kind: 'commit' }
            };
            qp.items = [syntheticItem, ...baseItems];
          } else {
            clearSynthetic();
          }
        } catch {
          if (seq === lookupSeq) {
            clearSynthetic();
          }
        } finally {
          if (seq === lookupSeq) {
            qp.busy = false;
          }
        }
      }, 150);
    });

    qp.onDidAccept(() => {
      const [selected] = qp.selectedItems;
      qp.hide();
      settle(selected?.revision);
    });

    qp.onDidHide(() => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      disposed = true;
      qp.dispose();
      settle(undefined);
    });

    qp.onDidTriggerButton((button) => {
      if (button === refreshButton) {
        refreshItems('Refreshing branches and tags…');
      }
    });

    qp.show();

    if (qp.items.length === 0) {
      refreshItems('Loading branches and tags…');
    }
  });
}
