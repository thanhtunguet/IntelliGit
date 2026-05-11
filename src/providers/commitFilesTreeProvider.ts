import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { CommitFileChange, WorkingTreeFileChange } from '../types';

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
    this.description = this.description.padStart(2, ' ');
    this.tooltip = `${filePath}\n${statusTitle(status)}`;
    this.command = {
      title: 'Open Commit File Diff',
      command: 'intelliGit.graph.openFileDiff',
      arguments: [this]
    };
  }
}

export class CommitRangeFileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly fromRef: string,
    public readonly toRef: string,
    public readonly fromLabel: string,
    public readonly toLabel: string,
    public readonly filePath: string,
    public readonly status: string,
    workspaceRoot: string
  ) {
    const fileName = filePath.split('/').at(-1) ?? filePath;
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.id = `commitView:range:file:${fromRef}:${toRef}:${filePath}`;
    this.contextValue = 'commitRangeFile';
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, filePath));
    this.description = statusBadge(status).padStart(2, ' ');
    this.tooltip = `${filePath}\n${statusTitle(status)}\n${fromLabel} ↔ ${toLabel}`;
    this.command = {
      title: 'Open Commit Range File Diff',
      command: 'intelliGit.graph.openFileDiff',
      arguments: [this]
    };
  }
}

export class RevisionFileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly sha: string,
    public readonly filePath: string,
    workspaceRoot: string
  ) {
    const fileName = filePath.split('/').at(-1) ?? filePath;
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.id = `commitView:revision:file:${sha}:${filePath}`;
    this.contextValue = 'revisionViewFile';
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, filePath));
    this.tooltip = `${filePath}\nRevision ${sha.slice(0, 8)}`;
    this.command = {
      title: 'Open File At Revision',
      command: 'intelliGit.graph.openRepositoryFileAtRevision',
      arguments: [this]
    };
  }
}

export class WorkingTreeCompareFileTreeItem extends vscode.TreeItem {
  constructor(
    public readonly ref: string,
    public readonly refLabel: string,
    public readonly filePath: string,
    public readonly status: string,
    public readonly untracked: boolean,
    workspaceRoot: string
  ) {
    const fileName = filePath.split('/').at(-1) ?? filePath;
    super(fileName, vscode.TreeItemCollapsibleState.None);
    this.id = `commitView:workingTreeCompare:${ref}:${filePath}`;
    this.contextValue = 'workingTreeCompareFile';
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, filePath));
    this.description = untracked ? 'Untracked' : statusBadge(status).padStart(2, ' ');
    this.tooltip = `${filePath}\n${untracked ? 'Untracked' : statusTitle(status)}`;
    this.command = {
      title: 'Open Working Tree File Diff',
      command: 'intelliGit.workingTreeCompare.openFileDiff',
      arguments: [this]
    };
  }
}

export class CommitFolderTreeItem extends vscode.TreeItem {
  constructor(
    public readonly idPrefix: string,
    public readonly folderPath: string,
    public readonly children: TreeFileEntry[],
    workspaceRoot: string
  ) {
    const segment = folderPath.split('/').at(-1) ?? folderPath;
    super(segment, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `${idPrefix}:folder:${folderPath}`;
    this.contextValue = 'commitViewFolder';
    this.resourceUri = vscode.Uri.file(path.join(workspaceRoot, folderPath));
  }
}

type CommitViewNode = CommitFileTreeItem | CommitRangeFileTreeItem | CommitFolderTreeItem | RevisionFileTreeItem | WorkingTreeCompareFileTreeItem;
type TreeFileEntry = { path: string; status?: string; untracked?: boolean };
export interface CommitActionContext {
  readonly sha: string;
  readonly subject: string;
  readonly filePaths: string[];
  readonly canRevertSelected: boolean;
  readonly canCherryPickSelected: boolean;
}
type ActiveTreeState =
  | { mode: 'commit'; sha: string; subject: string; files: CommitFileChange[]; canRevertSelected: boolean }
  | {
    mode: 'range';
    fromRef: string;
    toRef: string;
    fromLabel: string;
    toLabel: string;
    files: CommitFileChange[];
  }
  | { mode: 'revision'; sha: string; files: TreeFileEntry[] }
  | { mode: 'workingTreeCompare'; ref: string; refLabel: string; scopePath: string; files: WorkingTreeFileChange[] };

export class CommitFilesTreeProvider implements vscode.TreeDataProvider<CommitViewNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private activeState: ActiveTreeState | undefined;
  private view: vscode.TreeView<CommitViewNode> | undefined;

  constructor(private readonly git: GitService) { }

  attachView(view: vscode.TreeView<CommitViewNode> | undefined): void {
    this.view = view;
    this.updateViewTitle('Commit Details');
  }

  getTreeItem(element: CommitViewNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CommitViewNode): Promise<CommitViewNode[]> {
    if (!this.activeState) {
      return [];
    }

    if (!element) {
      if (this.activeState.mode === 'commit') {
        return buildCommitTree(this.activeState.sha, this.activeState.files, '', this.git.rootPath);
      }
      if (this.activeState.mode === 'range') {
        return buildCommitRangeTree(
          this.activeState.fromRef,
          this.activeState.toRef,
          this.activeState.fromLabel,
          this.activeState.toLabel,
          this.activeState.files,
          '',
          this.git.rootPath
        );
      }
      if (this.activeState.mode === 'workingTreeCompare') {
        return buildWorkingTreeCompareTree(
          this.activeState.ref,
          this.activeState.refLabel,
          this.activeState.files,
          '',
          this.git.rootPath
        );
      }
      return buildRevisionTree(this.activeState.sha, this.activeState.files, '', this.git.rootPath);
    }

    if (element instanceof CommitFolderTreeItem) {
      if (this.activeState.mode === 'commit') {
        return buildCommitTree(this.activeState.sha, element.children, element.folderPath, this.git.rootPath);
      }
      if (this.activeState.mode === 'range') {
        return buildCommitRangeTree(
          this.activeState.fromRef,
          this.activeState.toRef,
          this.activeState.fromLabel,
          this.activeState.toLabel,
          element.children,
          element.folderPath,
          this.git.rootPath
        );
      }
      if (this.activeState.mode === 'workingTreeCompare') {
        return buildWorkingTreeCompareTree(
          this.activeState.ref,
          this.activeState.refLabel,
          element.children,
          element.folderPath,
          this.git.rootPath
        );
      }
      return buildRevisionTree(this.activeState.sha, element.children, element.folderPath, this.git.rootPath);
    }

    return [];
  }

  async showCommit(sha: string, subject: string): Promise<void> {
    const files = await this.git.getFilesInCommitWithStatus(sha);
    const canRevert = await this.git.isCommitInCurrentBranch(sha);
    this.activeState = { mode: 'commit', sha, subject, files, canRevertSelected: canRevert };
    this.updateViewTitle(`Commit Details ${formatRevisionNumber(sha)}`);
    this.emitter.fire();
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewVisible', true);
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanRevertSelected', canRevert);
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanCherryPickSelected', !canRevert);
    await vscode.commands.executeCommand(`${CommitFilesTreeProviderViewId}.focus`);
  }

  async showRevision(sha: string): Promise<void> {
    const filePaths = await this.git.getFilesAtRevision(sha);
    const files = filePaths.map((filePath) => ({ path: filePath }));
    this.activeState = { mode: 'revision', sha, files };
    this.updateViewTitle(`Repository ${formatRevisionNumber(sha)}`);
    this.emitter.fire();
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewVisible', true);
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanRevertSelected', false);
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanCherryPickSelected', false);
    await vscode.commands.executeCommand(`${CommitFilesTreeProviderViewId}.focus`);
  }

  async showCommitRange({
    fromRef,
    toRef,
    fromLabel,
    toLabel,
    files
  }: {
    fromRef: string;
    toRef: string;
    fromLabel: string;
    toLabel: string;
    files: CommitFileChange[];
  }): Promise<void> {
    this.activeState = { mode: 'range', fromRef, toRef, fromLabel, toLabel, files };
    this.updateViewTitle(`Commit Details ${fromLabel}..${toLabel}`);
    this.emitter.fire();
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewVisible', true);
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanRevertSelected', false);
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanCherryPickSelected', false);
    await vscode.commands.executeCommand(`${CommitFilesTreeProviderViewId}.focus`);
  }

  async showWorkingTreeComparison({
    ref,
    refLabel,
    scopePath,
    files
  }: {
    ref: string;
    refLabel: string;
    scopePath: string;
    files: WorkingTreeFileChange[];
  }): Promise<void> {
    this.activeState = { mode: 'workingTreeCompare', ref, refLabel, scopePath, files };
    this.updateViewTitle('Commit Details');
    this.emitter.fire();
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewVisible', true);
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanRevertSelected', false);
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanCherryPickSelected', false);
    await vscode.commands.executeCommand(`${CommitFilesTreeProviderViewId}.focus`);
  }

  async clear(): Promise<void> {
    this.activeState = undefined;
    this.updateViewTitle('Commit Details');
    this.emitter.fire();
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewVisible', false);
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanRevertSelected', false);
    await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanCherryPickSelected', false);
  }

  getAllFileItems(): CommitFileTreeItem[] {
    if (!this.activeState || this.activeState.mode !== 'commit') {
      return [];
    }
    const activeCommit = this.activeState;
    return activeCommit.files
      .map((file) => new CommitFileTreeItem(activeCommit.sha, file.path, file.status, this.git.rootPath))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  getCommitActionContext(selectedItems: readonly CommitFileTreeItem[]): CommitActionContext | undefined {
    if (!this.activeState || this.activeState.mode !== 'commit') {
      return undefined;
    }

    const activeCommit = this.activeState;
    const allFiles = activeCommit.files.map((file) => file.path);
    const selectedPaths = [...new Set(selectedItems.map((item) => item.filePath).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b)
    );
    const filePaths = selectedPaths.length > 0 ? selectedPaths : allFiles;

    return {
      sha: activeCommit.sha,
      subject: activeCommit.subject,
      filePaths,
      canRevertSelected: activeCommit.canRevertSelected,
      canCherryPickSelected: !activeCommit.canRevertSelected
    };
  }

  private updateViewTitle(title: string): void {
    if (!this.view) {
      return;
    }
    this.view.title = title;
  }
}

const CommitFilesTreeProviderViewId = 'intelliGit.commitView';

function buildCommitTree(
  sha: string,
  files: TreeFileEntry[],
  basePath: string,
  workspaceRoot: string
): CommitViewNode[] {
  return buildTree(
    files,
    basePath,
    workspaceRoot,
    (filePath, status) => new CommitFileTreeItem(sha, filePath, status ?? '', workspaceRoot),
    (folderPath, children) => new CommitFolderTreeItem(`commitView:${sha}`, folderPath, children, workspaceRoot)
  );
}

function buildRevisionTree(
  sha: string,
  files: TreeFileEntry[],
  basePath: string,
  workspaceRoot: string
): CommitViewNode[] {
  return buildTree(
    files,
    basePath,
    workspaceRoot,
    (filePath) => new RevisionFileTreeItem(sha, filePath, workspaceRoot),
    (folderPath, children) => new CommitFolderTreeItem(`commitView:revision:${sha}`, folderPath, children, workspaceRoot)
  );
}

function buildCommitRangeTree(
  fromRef: string,
  toRef: string,
  fromLabel: string,
  toLabel: string,
  files: TreeFileEntry[],
  basePath: string,
  workspaceRoot: string
): CommitViewNode[] {
  return buildTree(
    files,
    basePath,
    workspaceRoot,
    (filePath, status) => new CommitRangeFileTreeItem(fromRef, toRef, fromLabel, toLabel, filePath, status ?? '', workspaceRoot),
    (folderPath, children) =>
      new CommitFolderTreeItem(`commitView:range:${fromRef}:${toRef}`, folderPath, children, workspaceRoot)
  );
}

function buildWorkingTreeCompareTree(
  ref: string,
  refLabel: string,
  files: TreeFileEntry[],
  basePath: string,
  workspaceRoot: string
): CommitViewNode[] {
  return buildTree(
    files,
    basePath,
    workspaceRoot,
    (filePath, status, untracked) => {
      return new WorkingTreeCompareFileTreeItem(ref, refLabel, filePath, status ?? '', untracked ?? false, workspaceRoot);
    },
    (folderPath, children) =>
      new CommitFolderTreeItem(`commitView:workingTreeCompare:${ref}`, folderPath, children, workspaceRoot)
  );
}

function buildTree(
  files: TreeFileEntry[],
  basePath: string,
  workspaceRoot: string,
  toFileItem: (filePath: string, status?: string, untracked?: boolean) => CommitFileTreeItem | CommitRangeFileTreeItem | RevisionFileTreeItem | WorkingTreeCompareFileTreeItem,
  toFolderItem: (folderPath: string, children: TreeFileEntry[]) => CommitFolderTreeItem
): CommitViewNode[] {
  const folders = new Map<string, TreeFileEntry[]>();
  const leaves: Array<CommitFileTreeItem | CommitRangeFileTreeItem | RevisionFileTreeItem | WorkingTreeCompareFileTreeItem> = [];

  for (const file of files) {
    const relative = basePath ? file.path.slice(basePath.length + 1) : file.path;
    const slashIdx = relative.indexOf('/');
    if (slashIdx === -1) {
      leaves.push(toFileItem(file.path, file.status, file.untracked));
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
    .map(([folderPath, children]) => toFolderItem(folderPath, children));

  leaves.sort((a, b) => a.resourceUri?.path.localeCompare(b.resourceUri?.path ?? '') ?? 0);
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

function formatRevisionNumber(revision: string): string {
  const token = (revision ?? '').trim();
  if (!token) {
    return '';
  }
  if (/^[0-9a-f]{9,}$/i.test(token)) {
    return token.slice(0, 8);
  }
  return token;
}
