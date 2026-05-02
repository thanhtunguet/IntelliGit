import * as path from 'path';
import * as vscode from 'vscode';
import { StateStore } from '../state/stateStore';
import { WorktreeEntry } from '../types';

export class WorktreeTreeItem extends vscode.TreeItem {
  constructor(public readonly worktree: WorktreeEntry) {
    const label = path.basename(worktree.worktreePath);
    super(label, vscode.TreeItemCollapsibleState.None);

    this.id = `worktree:${worktree.worktreePath}`;
    this.description = worktree.branch ?? (worktree.isDetached ? `detached ${worktree.headSha.slice(0, 8)}` : '');
    this.tooltip = buildWorktreeTooltip(worktree);

    const contextParts = ['worktreeEntry'];
    if (worktree.isCurrent) { contextParts.push('worktreeCurrent'); }
    if (worktree.isDirty) { contextParts.push('worktreeDirty'); }
    if (worktree.isLocked) { contextParts.push('worktreeLocked'); }
    if (worktree.isPrunable) { contextParts.push('worktreePrunable'); }
    this.contextValue = contextParts.join(' ');

    this.iconPath = worktree.isCurrent
      ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
      : worktree.isLocked
        ? new vscode.ThemeIcon('lock')
        : worktree.isPrunable
          ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
          : new vscode.ThemeIcon('folder');

    this.resourceUri = vscode.Uri.file(worktree.worktreePath);
    this.command = {
      command: 'intelliGit.worktree.open',
      title: 'Open Worktree',
      arguments: [this]
    };
  }
}

class WorktreeSectionNode extends vscode.TreeItem {
  constructor(
    public readonly kind: 'current' | 'other' | 'locked' | 'prunable',
    public readonly items: WorktreeEntry[],
    count: number
  ) {
    const labels: Record<typeof kind, string> = {
      current: 'Current',
      other: 'Other Worktrees',
      locked: 'Locked',
      prunable: 'Prunable / Stale'
    };
    super(labels[kind], vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'worktreeSection';
    this.id = `worktreeSection:${kind}`;
    this.description = `${count}`;
  }
}

type WorktreeNode = WorktreeSectionNode | WorktreeTreeItem;

export class WorktreeTreeProvider implements vscode.TreeDataProvider<WorktreeNode> {
  private readonly _emitter = new vscode.EventEmitter<WorktreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._emitter.event;

  constructor(private readonly store: StateStore) {
    store.onDidChange(() => this._emitter.fire());
  }

  getTreeItem(element: WorktreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: WorktreeNode): WorktreeNode[] {
    if (!element) {
      return this._buildSections();
    }
    if (element instanceof WorktreeSectionNode) {
      return element.items.map((w) => new WorktreeTreeItem(w));
    }
    return [];
  }

  private _buildSections(): WorktreeSectionNode[] {
    const worktrees = this.store.worktrees;
    const current = worktrees.filter((w) => w.isCurrent);
    const locked = worktrees.filter((w) => !w.isCurrent && w.isLocked);
    const prunable = worktrees.filter((w) => !w.isCurrent && !w.isLocked && w.isPrunable);
    const other = worktrees.filter((w) => !w.isCurrent && !w.isLocked && !w.isPrunable);

    const sections: WorktreeSectionNode[] = [];
    if (current.length > 0) { sections.push(new WorktreeSectionNode('current', current, current.length)); }
    if (other.length > 0) { sections.push(new WorktreeSectionNode('other', other, other.length)); }
    if (locked.length > 0) { sections.push(new WorktreeSectionNode('locked', locked, locked.length)); }
    if (prunable.length > 0) { sections.push(new WorktreeSectionNode('prunable', prunable, prunable.length)); }
    return sections;
  }

  refresh(): void {
    this._emitter.fire();
  }
}

function buildWorktreeTooltip(w: WorktreeEntry): string {
  const lines: string[] = [w.worktreePath];
  if (w.branch) { lines.push(`Branch: ${w.branch}`); }
  if (w.isDetached) { lines.push(`Detached HEAD: ${w.headSha.slice(0, 8)}`); }
  if (w.headSubject) { lines.push(`Latest: ${w.headSubject}`); }
  if (w.isDirty) { lines.push('Has uncommitted changes'); }
  if (w.ahead > 0 || w.behind > 0) {
    lines.push(`Upstream: ↑${w.ahead} ↓${w.behind}`);
  }
  if (w.isLocked) { lines.push(`Locked${w.lockReason ? `: ${w.lockReason}` : ''}`); }
  if (w.isPrunable) { lines.push('Prunable (stale)'); }
  return lines.join('\n');
}
