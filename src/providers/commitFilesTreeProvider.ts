import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { CommitFileChange } from '../types';

export class CommitFileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly sha: string,
    public readonly filePath: string,
    public readonly status: string,
    workspaceRoot: string
  ) {
    const fileName = filePath.split('/').at(-1) ?? filePath;
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.id = `commitView:file:${sha}:${filePath}`;
    this.contextValue = 'commitViewFile';
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, filePath));
    this.description = statusBadge(status);
    this.tooltip = `${filePath}\n${statusTitle(status)}`;
    this.command = {
      title: 'Open Commit File Diff',
      command: 'intelliGit.graph.openFileDiff',
      arguments: [this]
    };
  }
}

export class CommitFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly sha: string,
    public readonly folderPath: string,
    public readonly children: CommitFileChange[],
    workspaceRoot: string
  ) {
    const segment = folderPath.split('/').at(-1) ?? folderPath;
    super(segment, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `commitView:folder:${sha}:${folderPath}`;
    this.contextValue = 'commitViewFolder';
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, folderPath));
  }
}

type CommitViewNode = CommitFileTreeItem | CommitFolderTreeItem;

export class CommitFilesTreeProvider implements vscode.TreeDataProvider<CommitViewNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private activeCommit: { sha: string; subject: string; files: CommitFileChange[] } | undefined;

  constructor(private readonly git: GitService) {}

  getTreeItem(element: CommitViewNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CommitViewNode): Promise<CommitViewNode[]> {
    if (!this.activeCommit) {
      return [];
    }

    if (!element) {
      return buildTree(this.activeCommit.sha, this.activeCommit.files, '', this.git.rootPath);
    }

    if (element instanceof CommitFolderTreeItem) {
      return buildTree(this.activeCommit.sha, element.children, element.folderPath, this.git.rootPath);
    }

    return [];
  }

  async showCommit(sha: string, subject: string): Promise<void> {
    const files = await this.git.getFilesInCommitWithStatus(sha);
    this.activeCommit = { sha, subject, files };
    this.emitter.fire();
    await vscode.commands.executeCommand(`${CommitFilesTreeProviderViewId}.focus`);
  }

  async clear(): Promise<void> {
    this.activeCommit = undefined;
    this.emitter.fire();
  }
}

const CommitFilesTreeProviderViewId = 'intelliGit.commitView';

function buildTree(
  sha: string,
  files: CommitFileChange[],
  basePath: string,
  workspaceRoot: string
): CommitViewNode[] {
  const folders = new Map<string, CommitFileChange[]>();
  const leaves: CommitFileTreeItem[] = [];

  for (const file of files) {
    const relative = basePath ? file.path.slice(basePath.length + 1) : file.path;
    const slashIdx = relative.indexOf('/');
    if (slashIdx === -1) {
      leaves.push(new CommitFileTreeItem(sha, file.path, file.status, workspaceRoot));
      continue;
    }
    const segment = relative.slice(0, slashIdx);
    const childPath = basePath ? `${basePath}/${segment}` : segment;
    const list = folders.get(childPath) ?? [];
    list.push(file);
    folders.set(childPath, list);
  }

  const folderItems = [...folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folderPath, children]) => new CommitFolderTreeItem(sha, folderPath, children, workspaceRoot));

  leaves.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return [...folderItems, ...leaves];
}

function statusBadge(statusRaw: string): string {
  const status = normalizedStatus(statusRaw);
  if (status === 'A') return 'U';
  if (status === 'M') return 'M';
  if (status === 'D') return 'D';
  return status;
}

function statusTitle(statusRaw: string): string {
  const status = normalizedStatus(statusRaw);
  if (status === 'A') return 'Untracked';
  if (status === 'M') return 'Modified';
  if (status === 'D') return 'Deleted';
  if (status === 'R') return 'Renamed';
  if (status === 'C') return 'Copied';
  return status;
}

function normalizedStatus(statusRaw: string): string {
  const token = (statusRaw ?? '').trim();
  if (!token) return '?';
  return token[0].toUpperCase();
}
