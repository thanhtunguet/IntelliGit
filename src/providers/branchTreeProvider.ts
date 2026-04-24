import * as vscode from 'vscode';
import { StateStore } from '../state/stateStore';
import { BranchRef } from '../types';

class BranchSectionNode extends vscode.TreeItem {
  constructor(
    public readonly kind: 'recent' | 'local' | 'remote',
    public readonly branches: BranchRef[],
    count: number
  ) {
    const label = kind === 'recent' ? 'Recent' : kind === 'local' ? 'Local' : 'Remote';
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'branchSection';
    this.id = `branchSection:${kind}`;
    this.description = `${count}`;
  }
}

class BranchRemoteNode extends vscode.TreeItem {
  constructor(
    public readonly remoteName: string,
    public readonly branches: BranchRef[]
  ) {
    super(remoteName, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'branchRemoteGroup';
    this.id = `branchRemote:${remoteName}`;
  }
}

class BranchPathNode extends vscode.TreeItem {
  constructor(
    public readonly idPrefix: string,
    public readonly segment: string,
    public readonly fullPath: string,
    public readonly branches: BranchRef[],
    public readonly pathMode: 'name' | 'shortName'
  ) {
    super(segment, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'branchPathGroup';
    this.id = `branchPath:${idPrefix}:${fullPath}`;
  }
}

export class BranchTreeItem extends vscode.TreeItem {
  constructor(
    public readonly branch: BranchRef,
    label: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'branchRef';
    this.id = `branch:${branch.fullName}`;
    this.description = describeBranch(branch);
    this.tooltip = `${branch.name}\n${branch.fullName}${branch.upstream ? `\nupstream: ${branch.upstream}` : ''}`;
    this.iconPath = branch.current
      ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon(branch.type === 'remote' ? 'cloud' : 'git-branch');

    this.command = {
      title: 'Checkout Branch',
      command: 'intelliGit.branch.checkout',
      arguments: [this]
    };
  }
}

export class BranchTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly state: StateStore) {
    this.state.onDidChange(() => this.emitter.fire());
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    const branches = this.state.branches;

    if (!element) {
      return this.buildTopLevelSections(branches);
    }

    if (element instanceof BranchSectionNode) {
      if (element.kind === 'remote') {
        return this.buildRemoteNodes(element.branches);
      }
      return this.buildPathNodes(
        element.branches,
        '',
        element.kind === 'local' ? 'name' : 'shortName',
        element.kind
      );
    }

    if (element instanceof BranchRemoteNode) {
      return this.buildPathNodes(element.branches, '', 'shortName', `remote:${element.remoteName}`);
    }

    if (element instanceof BranchPathNode) {
      return this.buildPathNodes(element.branches, element.fullPath, element.pathMode, element.idPrefix);
    }

    return [];
  }

  private buildTopLevelSections(branches: BranchRef[]): vscode.TreeItem[] {
    const localBranches = branches.filter((branch) => branch.type === 'local');
    const remoteBranches = branches.filter((branch) => branch.type === 'remote');
    const recentBranches = this.getRecentBranches(branches);

    const sections: vscode.TreeItem[] = [];
    if (recentBranches.length > 0) {
      sections.push(new BranchSectionNode('recent', recentBranches, recentBranches.length));
    }
    if (localBranches.length > 0) {
      sections.push(new BranchSectionNode('local', localBranches, localBranches.length));
    }
    if (remoteBranches.length > 0) {
      sections.push(new BranchSectionNode('remote', remoteBranches, remoteBranches.length));
    }
    return sections;
  }

  private buildRemoteNodes(branches: BranchRef[]): vscode.TreeItem[] {
    const byRemote = new Map<string, BranchRef[]>();
    for (const branch of branches) {
      const remote = branch.remoteName ?? 'unknown';
      const list = byRemote.get(remote) ?? [];
      list.push(branch);
      byRemote.set(remote, list);
    }

    return Array.from(byRemote.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([remoteName, remoteBranches]) => new BranchRemoteNode(remoteName, remoteBranches));
  }

  private buildPathNodes(
    branches: BranchRef[],
    basePath: string,
    pathMode: 'name' | 'shortName',
    idPrefix: string
  ): vscode.TreeItem[] {
    const groups = new Map<string, BranchRef[]>();
    const leaves: BranchTreeItem[] = [];

    for (const branch of branches) {
      const branchPath = pathMode === 'name' ? branch.name : branch.shortName;
      const relativeName = basePath ? branchPath.slice(basePath.length + 1) : branchPath;
      if (!relativeName) {
        leaves.push(new BranchTreeItem(branch, branchPath.split('/').at(-1) ?? branchPath));
        continue;
      }

      const parts = relativeName.split('/');
      if (parts.length === 1) {
        leaves.push(new BranchTreeItem(branch, relativeName));
        continue;
      }

      const segment = parts[0];
      const childPath = basePath ? `${basePath}/${segment}` : segment;
      const list = groups.get(childPath) ?? [];
      list.push(branch);
      groups.set(childPath, list);
    }

    const groupItems = Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fullPath, branchSet]) => new BranchPathNode(idPrefix, fullPath.split('/').at(-1) ?? fullPath, fullPath, branchSet, pathMode));

    leaves.sort((a, b) => {
      if (a.branch.current) {
        return -1;
      }
      if (b.branch.current) {
        return 1;
      }
      const leftPath = pathMode === 'name' ? a.branch.name : a.branch.shortName;
      const rightPath = pathMode === 'name' ? b.branch.name : b.branch.shortName;
      return leftPath.localeCompare(rightPath);
    });

    return [...groupItems, ...leaves];
  }

  private getRecentBranches(branches: BranchRef[]): BranchRef[] {
    const maxRecent = Math.min(10, Math.max(1, vscode.workspace.getConfiguration('intelliGit').get<number>('recentBranchesCount', 3)));
    return [...branches]
      .sort((a, b) => {
        if (a.current) {
          return -1;
        }
        if (b.current) {
          return 1;
        }
        const left = a.lastCommitEpoch ?? 0;
        const right = b.lastCommitEpoch ?? 0;
        if (left !== right) {
          return right - left;
        }
        return a.name.localeCompare(b.name);
      })
      .slice(0, maxRecent);
  }
}

function describeBranch(branch: BranchRef): string {
  const parts: string[] = [];
  if (branch.current) {
    parts.push('current');
  }
  if (branch.type === 'remote') {
    parts.push('remote');
  }
  if (branch.upstream) {
    parts.push(`upstream: ${branch.upstream}`);
  }
  if (branch.ahead || branch.behind) {
    parts.push(`▲${branch.ahead} ▼${branch.behind}`);
  }
  return parts.join(' · ');
}
