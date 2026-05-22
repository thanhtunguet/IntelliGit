import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { StateStore } from '../state/stateStore';
import { GraphCommit } from '../types';

export class GraphCommitTreeItem extends vscode.TreeItem {
  constructor(public readonly commit: GraphCommit) {
    super(commit.subject, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'graphCommit';
    this.id = `commit:${commit.sha}`;
    // Keep hash in the native trailing description slot so subject stays ellipsized on the left.
    this.description = `  ${commit.shortSha}`;
    this.tooltip = [
      commit.sha,
      commit.subject,
      `Author: ${commit.author}`,
      `Date: ${new Date(commit.date).toLocaleString()}`,
      commit.refs.length ? `Refs: ${commit.refs.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('\n');
    this.iconPath = new vscode.ThemeIcon('git-commit');

  }
}

export class GraphCommitFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly commit: GraphCommit,
    public readonly folderPath: string,
    public readonly files: string[],
    workspaceRoot: string
  ) {
    const segment = folderPath.split('/').at(-1) ?? folderPath;
    super(segment, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'graphCommitFolder';
    this.id = `commitFolder:${commit.sha}:${folderPath}`;
    this.resourceUri = vscode.Uri.file(`${workspaceRoot}/${folderPath}`);
  }
}

export class GraphCommitFileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly commit: GraphCommit,
    public readonly filePath: string,
    workspaceRoot: string,
    canRevertSelectedChanges: boolean
  ) {
    const fileName = filePath.split('/').at(-1) ?? filePath;
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = canRevertSelectedChanges
      ? 'graphCommitFile graphCommitFileCanRevert'
      : 'graphCommitFile graphCommitFileCanCherryPick';
    this.id = `commitFile:${commit.sha}:${filePath}`;
    this.resourceUri = vscode.Uri.file(`${workspaceRoot}/${filePath}`);
    this.tooltip = `${filePath}\n${commit.shortSha} ${commit.subject}\nOpen Commit File Diff`;
    this.command = {
      title: 'Open Diff',
      command: 'vscodeGitClient.graph.openFileDiff',
      arguments: [this]
    };
  }
}

type GraphNode = GraphCommitTreeItem | GraphCommitFolderTreeItem | GraphCommitFileTreeItem;

function buildFileTree(
  commit: GraphCommit,
  files: string[],
  basePath: string,
  workspaceRoot: string,
  canRevertSelectedChanges: boolean
): GraphNode[] {
  const folders = new Map<string, string[]>();
  const leaves: GraphCommitFileTreeItem[] = [];

  for (const file of files) {
    const relative = basePath ? file.slice(basePath.length + 1) : file;
    const slashIdx = relative.indexOf('/');
    if (slashIdx === -1) {
      leaves.push(new GraphCommitFileTreeItem(commit, file, workspaceRoot, canRevertSelectedChanges));
    } else {
      const segment = relative.slice(0, slashIdx);
      const childPath = basePath ? `${basePath}/${segment}` : segment;
      const list = folders.get(childPath) ?? [];
      list.push(file);
      folders.set(childPath, list);
    }
  }

  const folderItems = Array.from(folders.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, fileSet]) => new GraphCommitFolderTreeItem(commit, path, fileSet, workspaceRoot));

  leaves.sort((a, b) => a.filePath.localeCompare(b.filePath));

  return [...folderItems, ...leaves];
}

export class GraphTreeProvider implements vscode.TreeDataProvider<GraphNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly commitFilesCache = new Map<string, string[]>();
  private readonly commitAncestryCache = new Map<string, boolean>();

  constructor(
    private readonly state: StateStore,
    private readonly git: GitService
  ) {
    this.state.onDidChange(() => {
      this.commitAncestryCache.clear();
      this.emitter.fire();
    });
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(element: GraphNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: GraphNode): Promise<GraphNode[]> {
    if (element instanceof GraphCommitTreeItem) {
      const commitSha = element.commit.sha;
      let files = this.commitFilesCache.get(commitSha);
      if (!files) {
        files = await this.git.getFilesInCommit(commitSha);
        this.commitFilesCache.set(commitSha, files);
      }

      const canRevertSelectedChanges = await this.canRevertSelectedChanges(commitSha);
      return buildFileTree(element.commit, files, '', this.git.rootPath, canRevertSelectedChanges);
    }

    if (element instanceof GraphCommitFolderTreeItem) {
      const canRevertSelectedChanges = await this.canRevertSelectedChanges(element.commit.sha);
      return buildFileTree(element.commit, element.files, element.folderPath, this.git.rootPath, canRevertSelectedChanges);
    }

    return this.state.graph.map((commit) => new GraphCommitTreeItem(commit));
  }

  private async canRevertSelectedChanges(sha: string): Promise<boolean> {
    const cached = this.commitAncestryCache.get(sha);
    if (cached !== undefined) {
      return cached;
    }

    const canRevertSelectedChanges = await this.git.isCommitInCurrentBranch(sha);
    this.commitAncestryCache.set(sha, canRevertSelectedChanges);
    return canRevertSelectedChanges;
  }
}
