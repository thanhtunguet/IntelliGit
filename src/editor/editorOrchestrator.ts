import * as path from 'path';
import * as vscode from 'vscode';
import { GitService } from '../services/gitService';
import { StateStore } from '../state/stateStore';
import { CompareView } from '../views/compareView';
import { CompareResult } from '../types';
import { VirtualGitContentProvider } from './virtualGitContentProvider';

export class EditorOrchestrator {
  private compareView: CompareView | undefined;

  constructor(
    private readonly git: GitService,
    private readonly state: StateStore,
    private readonly extensionUri: vscode.Uri,
    private readonly contentProvider: VirtualGitContentProvider
  ) {}

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
    this.ensureCompareView().render(result);
    this.ensureCompareView().reveal();
    return result;
  }

  async openCompareFromCommit(commitSha: string): Promise<void> {
    const current = await this.git.getCurrentBranch();
    await this.openBranchCompare(commitSha, current);
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
    await this.openDiffForFile({
      path: filePath,
      leftRef: `${sha}^`,
      rightRef: sha,
      title: `${sha.slice(0, 8)} parent ↔ commit · ${filePath}`
    });
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

  private async openCommitFileDiffBeside(sha: string, filePath: string): Promise<void> {
    const leftUri = await this.createVirtualUri(`${sha}^`, filePath);
    const rightUri = await this.createVirtualUri(sha, filePath);
    const title = `${sha.slice(0, 8)} parent ↔ commit · ${filePath}`;

    await vscode.commands.executeCommand('vscode.setEditorLayout', {
      orientation: 0,
      groups: [
        { orientation: 1, groups: [{ size: 0.5 }, { size: 0.5 }], size: 0.55 },
        { size: 0.45 }
      ]
    });

    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, {
      preview: false,
      preserveFocus: true,
      viewColumn: vscode.ViewColumn.Three
    });
  }

  private ensureCompareView(): CompareView {
    if (!this.compareView) {
      this.compareView = new CompareView(this.extensionUri, this.git, async (sha, filePath) => {
        await this.openCommitFileDiffBeside(sha, filePath);
      });
      this.compareView.onDispose(() => {
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
}
