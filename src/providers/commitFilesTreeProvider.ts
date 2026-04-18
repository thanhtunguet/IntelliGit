import * as vscode from 'vscode';

export class CommitFolderItem extends vscode.TreeItem {
  constructor(
    public readonly folderPath: string,
    public readonly files: string[],
    workspaceRoot: string
  ) {
    const segment = folderPath.split('/').at(-1) ?? folderPath;
    super(segment, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = 'commitFolder';
    this.resourceUri = vscode.Uri.file(`${workspaceRoot}/${folderPath}`);
  }
}

export class CommitFileItem extends vscode.TreeItem {
  constructor(
    public readonly sha: string,
    public readonly filePath: string,
    workspaceRoot: string
  ) {
    const name = filePath.split('/').at(-1) ?? filePath;
    super(name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'commitFile';
    this.resourceUri = vscode.Uri.file(`${workspaceRoot}/${filePath}`);
    this.tooltip = filePath;
    this.command = {
      title: 'Open Diff',
      command: 'intelliGit.commitFiles.openDiff',
      arguments: [sha, filePath]
    };
  }
}

type CommitNode = CommitFolderItem | CommitFileItem;

export class CommitFilesTreeProvider implements vscode.TreeDataProvider<CommitNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private sha: string | undefined;
  private files: string[] = [];
  private rootPath: string = '';

  showCommit(sha: string, files: string[], rootPath: string): void {
    this.sha = sha;
    this.files = files;
    this.rootPath = rootPath;
    this.emitter.fire();
  }

  clear(): void {
    this.sha = undefined;
    this.files = [];
    this.emitter.fire();
  }

  getTreeItem(element: CommitNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: CommitNode): CommitNode[] {
    if (!this.sha) {
      return [];
    }
    if (!element) {
      return buildTree(this.sha, this.files, '', this.rootPath);
    }
    if (element instanceof CommitFolderItem) {
      return buildTree(this.sha, element.files, element.folderPath, this.rootPath);
    }
    return [];
  }
}

function buildTree(sha: string, files: string[], basePath: string, rootPath: string): CommitNode[] {
  const folders = new Map<string, string[]>();
  const leaves: CommitFileItem[] = [];

  for (const file of files) {
    const relative = basePath ? file.slice(basePath.length + 1) : file;
    const slash = relative.indexOf('/');
    if (slash === -1) {
      leaves.push(new CommitFileItem(sha, file, rootPath));
    } else {
      const segment = relative.slice(0, slash);
      const childPath = basePath ? `${basePath}/${segment}` : segment;
      const list = folders.get(childPath) ?? [];
      list.push(file);
      folders.set(childPath, list);
    }
  }

  const folderItems = [...folders.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, children]) => new CommitFolderItem(path, children, rootPath));

  leaves.sort((a, b) => a.filePath.localeCompare(b.filePath));

  return [...folderItems, ...leaves];
}
