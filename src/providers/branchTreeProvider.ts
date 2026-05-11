import * as vscode from 'vscode';
import { StateStore } from '../state/stateStore';
import { BranchRef, TagRef } from '../types';
import { formatComparisonSummary } from '../services/gitParsing';

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

class TagSectionNode extends vscode.TreeItem {
  constructor(public readonly tags: TagRef[], count: number) {
    super('Tags', vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'tagSection';
    this.id = 'branchSection:tags';
    this.description = `${count}`;
  }
}

export class BranchRemoteNode extends vscode.TreeItem {
  constructor(
    public readonly remoteName: string,
    public readonly branches: BranchRef[],
    remoteUrl?: string
  ) {
    super(remoteName, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'branchRemoteGroup';
    this.id = `branchRemote:${remoteName}`;
    if (remoteUrl) {
      this.tooltip = remoteUrl;
    }
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

class TagPathNode extends vscode.TreeItem {
  constructor(
    public readonly idPrefix: string,
    public readonly segment: string,
    public readonly fullPath: string,
    public readonly tags: TagRef[]
  ) {
    super(segment, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'tagPathGroup';
    this.id = `tagPath:${idPrefix}:${fullPath}`;
  }
}

export class BranchTreeItem extends vscode.TreeItem {
  constructor(
    public readonly branch: BranchRef,
    label: string,
    idScope: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'branchRef';
    this.id = `branch:${idScope}:${branch.fullName}`;
    this.description = describeBranch(branch);
    this.tooltip = buildBranchTooltip(branch);
    this.iconPath = branch.current
      ? new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'))
      : new vscode.ThemeIcon(branch.type === 'remote' ? 'cloud' : 'git-branch');

    this.command = {
      title: 'Open Branch Commits',
      command: 'intelliGit.branch.openCommits',
      arguments: [this]
    };
  }
}

export class TagTreeItem extends vscode.TreeItem {
  constructor(
    public readonly tag: TagRef,
    label: string,
    idScope: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'tagRef';
    this.id = `tag:${idScope}:${tag.fullName}`;
    this.tooltip = buildTagTooltip(tag);
    this.iconPath = new vscode.ThemeIcon('tag');
    this.command = {
      title: 'Open Tag Commits',
      command: 'intelliGit.tag.openCommits',
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
    const tags = this.state.tags;

    if (!element) {
      return this.buildTopLevelSections(branches, tags);
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

    if (element instanceof TagSectionNode) {
      return this.buildTagPathNodes(element.tags, '', 'tags');
    }

    if (element instanceof TagPathNode) {
      return this.buildTagPathNodes(element.tags, element.fullPath, element.idPrefix);
    }

    return [];
  }

  private buildTopLevelSections(branches: BranchRef[], tags: TagRef[]): vscode.TreeItem[] {
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
    if (tags.length > 0) {
      sections.push(new TagSectionNode(tags, tags.length));
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
      .map(([remoteName, remoteBranches]) => new BranchRemoteNode(remoteName, remoteBranches, remoteBranches[0]?.remoteUrl));
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
        leaves.push(new BranchTreeItem(branch, branchPath.split('/').at(-1) ?? branchPath, idPrefix));
        continue;
      }

      const parts = relativeName.split('/');
      if (parts.length === 1) {
        leaves.push(new BranchTreeItem(branch, relativeName, idPrefix));
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

  private buildTagPathNodes(tags: TagRef[], basePath: string, idPrefix: string): vscode.TreeItem[] {
    const groups = new Map<string, TagRef[]>();
    const leaves: TagTreeItem[] = [];

    for (const tag of tags) {
      const relativeName = basePath ? tag.name.slice(basePath.length + 1) : tag.name;
      if (!relativeName) {
        leaves.push(new TagTreeItem(tag, tag.name.split('/').at(-1) ?? tag.name, idPrefix));
        continue;
      }

      const parts = relativeName.split('/');
      if (parts.length === 1) {
        leaves.push(new TagTreeItem(tag, relativeName, idPrefix));
        continue;
      }

      const segment = parts[0];
      const childPath = basePath ? `${basePath}/${segment}` : segment;
      const list = groups.get(childPath) ?? [];
      list.push(tag);
      groups.set(childPath, list);
    }

    const groupItems = Array.from(groups.entries())
      .sort(([a, leftTags], [b, rightTags]) => {
        const leftLatest = latestTagEpoch(leftTags);
        const rightLatest = latestTagEpoch(rightTags);
        if (leftLatest !== rightLatest) {
          return rightLatest - leftLatest;
        }
        return a.localeCompare(b);
      })
      .map(([fullPath, tagSet]) => new TagPathNode(idPrefix, fullPath.split('/').at(-1) ?? fullPath, fullPath, tagSet));

    leaves.sort((a, b) => compareTagsByTimeDesc(a.tag, b.tag));

    return [...groupItems, ...leaves];
  }
}

function compareTagsByTimeDesc(a: TagRef, b: TagRef): number {
  const left = a.lastCommitEpoch ?? 0;
  const right = b.lastCommitEpoch ?? 0;
  if (left !== right) {
    return right - left;
  }
  return a.name.localeCompare(b.name);
}

function latestTagEpoch(tags: TagRef[]): number {
  return Math.max(0, ...tags.map((tag) => tag.lastCommitEpoch ?? 0));
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

function buildBranchTooltip(branch: BranchRef): string {
  const lines = [
    branch.name,
    branch.fullName,
    `Last update: ${formatEpoch(branch.lastCommitEpoch)}`,
    branch.upstream ? `Upstream: ${branch.upstream}` : '',
    formatComparison(branch.comparison)
  ];
  return lines.filter(Boolean).join('\n');
}

function buildTagTooltip(tag: TagRef): string {
  const lines = [
    tag.name,
    tag.fullName,
    tag.sha ? `Revision: ${tag.sha}` : '',
    `Last update: ${formatEpoch(tag.lastCommitEpoch)}`,
    formatComparison(tag.comparison)
  ];
  return lines.filter(Boolean).join('\n');
}

function formatComparison(comparison: BranchRef['comparison'] | TagRef['comparison']): string {
  if (!comparison) {
    return '';
  }
  return formatComparisonSummary(comparison.ref, comparison.ahead, comparison.behind);
}

function formatEpoch(epoch: number | undefined): string {
  if (!epoch) {
    return 'unknown';
  }
  return new Date(epoch * 1000).toLocaleString();
}
