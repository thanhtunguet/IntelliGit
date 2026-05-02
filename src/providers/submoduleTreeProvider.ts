import * as vscode from 'vscode';
import { StateStore } from '../state/stateStore';
import { SubmoduleEntry } from '../types';

export class SubmoduleTreeItem extends vscode.TreeItem {
  constructor(public readonly submodule: SubmoduleEntry) {
    const hasNested = submodule.submodules.length > 0;
    super(
      submodule.name,
      hasNested ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
    );

    this.id = `submodule:${submodule.path}`;
    this.description = submodule.url;
    this.tooltip = buildSubmoduleTooltip(submodule);

    const contextParts = ['submoduleEntry'];
    if (submodule.isDirty) { contextParts.push('submoduleDirty'); }
    if (!submodule.isInitialized) { contextParts.push('submoduleUninitialized'); }
    if (submodule.isPointerMismatch) { contextParts.push('submodulePointerChanged'); }
    this.contextValue = contextParts.join(' ');

    if (!submodule.isInitialized) {
      this.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('list.warningForeground'));
    } else if (submodule.isDirty) {
      this.iconPath = new vscode.ThemeIcon('git-commit', new vscode.ThemeColor('list.warningForeground'));
    } else if (submodule.isPointerMismatch) {
      this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
    } else {
      this.iconPath = new vscode.ThemeIcon('folder-library');
    }
  }
}

class SubmoduleSectionNode extends vscode.TreeItem {
  constructor(
    public readonly kind: 'attention' | 'clean' | 'uninitialized' | 'nested',
    public readonly items: SubmoduleEntry[],
    count: number
  ) {
    const labels: Record<typeof kind, string> = {
      attention: 'Needs Attention',
      clean: 'Clean',
      uninitialized: 'Uninitialized',
      nested: 'Nested'
    };
    super(labels[kind], vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'submoduleSection';
    this.id = `submoduleSection:${kind}`;
    this.description = `${count}`;
  }
}

type SubmoduleNode = SubmoduleSectionNode | SubmoduleTreeItem;

export class SubmoduleTreeProvider implements vscode.TreeDataProvider<SubmoduleNode> {
  private readonly _emitter = new vscode.EventEmitter<SubmoduleNode | undefined | void>();
  readonly onDidChangeTreeData = this._emitter.event;

  constructor(private readonly store: StateStore) {
    store.onDidChange(() => this._emitter.fire());
  }

  getTreeItem(element: SubmoduleNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SubmoduleNode): SubmoduleNode[] {
    if (!element) {
      return this._buildSections();
    }
    if (element instanceof SubmoduleSectionNode) {
      return element.items.map((s) => new SubmoduleTreeItem(s));
    }
    if (element instanceof SubmoduleTreeItem) {
      return element.submodule.submodules.map((s) => new SubmoduleTreeItem(s));
    }
    return [];
  }

  private _buildSections(): SubmoduleSectionNode[] {
    const submodules = this.store.submodules;
    const uninitialized = submodules.filter((s) => !s.isInitialized && s.submodules.length === 0);
    const nested = submodules.filter((s) => s.submodules.length > 0);
    const attention = submodules.filter(
      (s) => s.isInitialized && (s.isDirty || s.isPointerMismatch) && s.submodules.length === 0
    );
    const clean = submodules.filter(
      (s) => s.isInitialized && !s.isDirty && !s.isPointerMismatch && s.submodules.length === 0
    );

    const sections: SubmoduleSectionNode[] = [];
    if (attention.length > 0) { sections.push(new SubmoduleSectionNode('attention', attention, attention.length)); }
    if (clean.length > 0) { sections.push(new SubmoduleSectionNode('clean', clean, clean.length)); }
    if (uninitialized.length > 0) { sections.push(new SubmoduleSectionNode('uninitialized', uninitialized, uninitialized.length)); }
    if (nested.length > 0) { sections.push(new SubmoduleSectionNode('nested', nested, nested.length)); }
    return sections;
  }

  refresh(): void {
    this._emitter.fire();
  }
}

function buildSubmoduleTooltip(s: SubmoduleEntry): string {
  const lines: string[] = [`Path: ${s.path}`, `URL: ${s.url}`];
  if (s.branch) { lines.push(`Branch: ${s.branch}`); }
  if (s.currentSha) { lines.push(`Current SHA: ${s.currentSha.slice(0, 8)}`); }
  if (s.recordedSha) { lines.push(`Recorded SHA: ${s.recordedSha.slice(0, 8)}`); }
  if (!s.isInitialized) { lines.push('Not initialized'); }
  if (s.isDirty) { lines.push('Has uncommitted changes'); }
  if (s.isPointerMismatch) { lines.push('Pointer differs from recorded SHA'); }
  if (s.ahead > 0 || s.behind > 0) { lines.push(`Upstream: ↑${s.ahead} ↓${s.behind}`); }
  return lines.join('\n');
}
