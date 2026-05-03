import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { StateStore } from '../state/stateStore';
import { GraphCommit } from '../types';

export class GraphCommitTreeItem extends vscode.TreeItem {
  constructor(public readonly commit: GraphCommit) {
    const graphGlyph = commit.graph === '<' ? '◀' : commit.graph === '>' ? '▶' : commit.graph === '-' ? '●' : '○';
    super(`${graphGlyph} ${commit.shortSha} ${commit.subject}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'graphCommit';
    this.id = `commit:${commit.sha}`;
    this.description = [commit.author, new Date(commit.date).toLocaleString()].join(' · ');
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
    workspaceRoot: string
  ) {
    const fileName = filePath.split('/').at(-1) ?? filePath;
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'graphCommitFile';
    this.id = `commitFile:${commit.sha}:${filePath}`;
    this.resourceUri = vscode.Uri.file(`${workspaceRoot}/${filePath}`);
    this.tooltip = `${filePath}\n${commit.shortSha} ${commit.subject}\nOpen Commit File Diff`;
    this.command = {
      title: 'Open Diff',
      command: 'intelliGit.graph.openFileDiff',
      arguments: [this]
    };
  }
}

type GraphNode = GraphCommitTreeItem | GraphCommitFolderTreeItem | GraphCommitFileTreeItem;

function buildFileTree(
  commit: GraphCommit,
  files: string[],
  basePath: string,
  workspaceRoot: string
): GraphNode[] {
  const folders = new Map<string, string[]>();
  const leaves: GraphCommitFileTreeItem[] = [];

  for (const file of files) {
    const relative = basePath ? file.slice(basePath.length + 1) : file;
    const slashIdx = relative.indexOf('/');
    if (slashIdx === -1) {
      leaves.push(new GraphCommitFileTreeItem(commit, file, workspaceRoot));
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

  constructor(
    private readonly state: StateStore,
    private readonly git: GitService
  ) {
    this.state.onDidChange(() => this.emitter.fire());
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

      return buildFileTree(element.commit, files, '', this.git.rootPath);
    }

    if (element instanceof GraphCommitFolderTreeItem) {
      return buildFileTree(element.commit, element.files, element.folderPath, this.git.rootPath);
    }

    return this.state.graph.map((commit) => new GraphCommitTreeItem(commit));
  }
}
