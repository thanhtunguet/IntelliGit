import * as path from 'path';
import * as vscode from 'vscode';
import { CommitFilesTreeProvider } from '../providers/commitFilesTreeProvider';
import { GitService } from '../services/gitService';
import { StateStore } from '../state/stateStore';
import { CompareResult } from '../types';
import { CompareCommitRangeSelection, CompareView } from '../views/compareView';
import { VirtualGitContentProvider } from './virtualGitContentProvider';

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export class EditorOrchestrator {
  private compareView: CompareView | undefined;

  constructor(
    private readonly git: GitService,
    private readonly state: StateStore,
    private readonly contentProvider: VirtualGitContentProvider,
    private readonly commitFilesView: CommitFilesTreeProvider
  ) { }

  async openMergeConflict(filePath: string): Promise<void> {
    await this.git.openMergeEditor(filePath);
  }

  async openDiffForFile(options: {
    path: string;
    leftRef: string;
    rightRef: string;
    title?: string;
  }): Promise<void> {
    const leftUri = await this.createVirtualUri(options.leftRef, options.path);
    const rightUri = await this.createVirtualUri(options.rightRef, options.path);
    const title = options.title ?? `${options.leftRef} ↔ ${options.rightRef} · ${options.path}`;

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
      preview: false,
      preserveFocus: false
    });
  }

  async openDiffForUri(uri: vscode.Uri, title: string): Promise<void> {
    await vscode.commands.executeCommand('vscode.diff', uri.with({ query: 'left' }), uri.with({ query: 'right' }), title, {
      preview: false,
      preserveFocus: false
    });
  }

  async openBranchCompare(leftRef: string, rightRef: string): Promise<CompareResult> {
    const result = await this.state.compareBranches(leftRef, rightRef);
    await this.commitFilesView.clear();
    this.ensureCompareView().render(result);
    this.ensureCompareView().reveal();
    return result;
  }

  async openCompareFromCommit(commitSha: string): Promise<void> {
    const current = await this.git.getCurrentBranch();
    await this.openBranchCompare(commitSha, current);
  }

  async showRepositoryAtRevision(sha: string): Promise<void> {
    await this.commitFilesView.showRevision(sha);
  }

  async openCommitFilesDiff(sha: string): Promise<void> {
    const files = await this.git.getFilesInCommit(sha);
    const choice = await vscode.window.showQuickPick(files, {
      title: `Commit ${sha.slice(0, 8)} files`,
      placeHolder: 'Pick a file to diff against parent'
    });

    if (!choice) {
      return;
    }

    await this.openDiffForFile({
      path: choice,
      leftRef: `${sha}^`,
      rightRef: sha,
      title: `${sha.slice(0, 8)} parent ↔ commit · ${choice}`
    });
  }

  async openCommitFileDiff(sha: string, filePath: string): Promise<void> {
    await this.openCommitFileDiffWithStatus(sha, filePath);
  }

  async openBranchComparisonFileDiff(leftRef: string, rightRef: string): Promise<void> {
    const files = await this.git.getFilesChangedBetween(leftRef, rightRef);
    const choice = await vscode.window.showQuickPick(files, {
      title: `Files changed between ${leftRef} and ${rightRef}`,
      placeHolder: 'Pick a file to open diff'
    });

    if (!choice) {
      return;
    }

    await this.openDiffForFile({
      path: choice,
      leftRef,
      rightRef,
      title: `${leftRef} ↔ ${rightRef} · ${choice}`
    });
  }

  async openCommitFileDiffWithStatus(sha: string, filePath: string, status?: string): Promise<void> {
    const title = `${sha.slice(0, 8)} parent ↔ commit · ${filePath}`;
    const normalizedStatus = (status ?? '').trim().toUpperCase();

    let leftContent = '';
    let rightContent = '';

    if (normalizedStatus !== 'A') {
      leftContent = await this.readContentOrEmpty(`${sha}^`, filePath);
    }

    if (normalizedStatus !== 'D') {
      rightContent = await this.readContentOrEmpty(sha, filePath);
    }

    const normalized = filePath.replaceAll(path.sep, '/');
    const leftUri = vscode.Uri.parse(`intelligit:${encodeURIComponent(`${sha}^`)}/${normalized}`);
    const rightUri = vscode.Uri.parse(`intelligit:${encodeURIComponent(sha)}/${normalized}`);
    this.contentProvider.setContent(leftUri, leftContent);
    this.contentProvider.setContent(rightUri, rightContent);

    await this.closeEmptyEditorGroups();
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
      preview: false,
      preserveFocus: false
    });
  }

  async openCommitRangeFileDiff(
    fromRef: string,
    toRef: string,
    filePath: string,
    labels?: { fromLabel?: string; toLabel?: string }
  ): Promise<void> {
    await this.closeEmptyEditorGroups();
    await this.openDiffForFile({
      path: filePath,
      leftRef: fromRef,
      rightRef: toRef,
      title: `${labels?.fromLabel ?? formatRevisionLabel(fromRef)} ↔ ${labels?.toLabel ?? formatRevisionLabel(toRef)} · ${filePath}`
    });
  }

  async openWorkingTreeFileDiff(
    relativePath: string,
    ref: string,
    refLabel: string,
    opts: { preview: boolean; status?: string }
  ): Promise<void> {
    const left = await this.createVirtualUri(ref, relativePath);

    let right: vscode.Uri;
    const gitRoot = await this.git.getGitRoot();
    const onDiskUri = vscode.Uri.file(path.join(gitRoot, relativePath));
    const fileMissing = opts.status === 'D' || !(await this.fileExists(onDiskUri));
    if (fileMissing) {
      const normalized = relativePath.replaceAll(path.sep, '/');
      right = vscode.Uri.parse(`intelligit:${encodeURIComponent('WORKTREE')}/${normalized}`);
      this.contentProvider.setContent(right, '');
    } else {
      right = onDiskUri;
    }

    const title = `${refLabel} ↔ working tree · ${relativePath}`;
    await vscode.commands.executeCommand('vscode.diff', left, right, title, {
      preview: opts.preview,
      preserveFocus: false
    });
  }

  async openCompareWithRevisionForFile(
    relativePath: string,
    ref: string,
    refLabel: string
  ): Promise<void> {
    await this.openWorkingTreeFileDiff(relativePath, ref, refLabel, { preview: false });
  }

  async openCompareWithRevisionForFolder(
    folderRelPath: string,
    ref: string,
    refLabel: string
  ): Promise<void> {
    const scopeForGit = folderRelPath || undefined;
    const scopeForView = folderRelPath || '.';
    const files = await this.git.getFilesChangedBetweenWorkingTreeAndRef(ref, scopeForGit);
    if (files.length === 0) {
      void vscode.window.showInformationMessage(
        `No differences in ${scopeForView} against ${refLabel}.`
      );
      return;
    }

    await this.commitFilesView.showWorkingTreeComparison({
      ref,
      refLabel,
      scopePath: scopeForView,
      files
    });

    const first = files[0];
    await this.openWorkingTreeFileDiff(first.path, ref, refLabel, {
      preview: true,
      status: first.status
    });
  }

  async openCompareCommitRangeDetails(selection: CompareCommitRangeSelection): Promise<void> {
    if (selection.shas.length < 2) {
      return;
    }

    const newestSha = selection.shas[0]!;
    const oldestSha = selection.shas[selection.shas.length - 1]!;
    const oldestParent = await this.git.getParentCommit(oldestSha);
    const fromRef = oldestParent ? `${oldestSha}^` : EMPTY_TREE_SHA;
    const toRef = newestSha;
    const fromLabel = oldestParent ? `${oldestSha.slice(0, 8)}^` : 'root';
    const toLabel = newestSha.slice(0, 8);
    const files = await this.git.getFilesChangedBetweenRefsWithStatus(fromRef, toRef);

    await this.commitFilesView.showCommitRange({
      fromRef,
      toRef,
      fromLabel,
      toLabel,
      files
    });
    if (files.length === 0) {
      void vscode.window.showInformationMessage('Selected commit range has no net file changes.');
    }
  }

  private async fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  async openFileAtRevision(ref: string, filePath: string): Promise<void> {
    const uri = await this.createVirtualUri(ref, filePath);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside });
  }

  async openWorkingTreeFile(filePath: string): Promise<void> {
    const gitRoot = await this.git.getGitRoot();
    const uri = vscode.Uri.file(path.join(gitRoot, filePath));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
  }

  private ensureCompareView(): CompareView {
    if (!this.compareView) {
      this.compareView = new CompareView(
        async (sha, subject) => {
          await this.commitFilesView.showCommit(sha, subject);
        },
        async (selection) => {
          await this.openCompareCommitRangeDetails(selection);
        }
      );
      this.compareView.onDispose(() => {
        void this.commitFilesView.clear();
        this.compareView = undefined;
      });
    }
    return this.compareView;
  }

  private async createVirtualUri(ref: string, relativePath: string): Promise<vscode.Uri> {
    const normalized = relativePath.replaceAll(path.sep, '/');
    const uri = vscode.Uri.parse(`intelligit:${encodeURIComponent(ref)}/${normalized}`);
    const content = await this.git.getFileContentFromRef(ref, relativePath);
    this.contentProvider.setContent(uri, content);
    return uri;
  }

  private async readContentOrEmpty(ref: string, relativePath: string): Promise<string> {
    try {
      return await this.git.getFileContentFromRef(ref, relativePath);
    } catch {
      return '';
    }
  }

  private async closeEmptyEditorGroups(): Promise<void> {
    const groups = vscode.window.tabGroups.all;
    const allGroupsAreEmpty = groups.every((group) => group.tabs.length === 0);
    const emptyGroups = groups.filter((group) => group.tabs.length === 0 && !(allGroupsAreEmpty && group.isActive));

    if (emptyGroups.length > 0) {
      await vscode.window.tabGroups.close(emptyGroups, true);
    }
  }
}

function formatRevisionLabel(ref: string): string {
  const token = (ref ?? '').trim();
  if (!token) {
    return '';
  }
  if (/^[0-9a-f]{9,}$/i.test(token)) {
    return token.slice(0, 8);
  }
  return token;
}
