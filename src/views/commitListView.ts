import * as vscode from 'vscode';
import { handleCommitAction, isCommitActionMessage, type CommitActionMessage } from './commitActions';
import { collectBranchNames, serializeCommits } from './commitFilterModel';
import { renderTemplate } from './templateRenderer';
import { BranchRef, GraphCommit } from '../types';

export interface CommitListOptions {
  readonly id: string;
  readonly title: string;
  readonly hint: string;
  readonly branches: readonly BranchRef[];
  readonly commits: readonly GraphCommit[];
}

export interface CommitListHandlers {
  openCommitDetails(sha: string, subject: string): Promise<void>;
  getCommitFiles(sha: string): Promise<string[]>;
  openFileDiff(sha: string, filePath: string): Promise<void>;
}

type IncomingMessage =
  | { type: 'close' }
  | { type: 'openCommitDetails'; sha: string; subject: string }
  | { type: 'loadCommitFiles'; sha: string }
  | { type: 'openCommitFile'; sha: string; filePath: string }
  | CommitActionMessage;

export class CommitListView {
  private static readonly current = new Map<string, CommitListView>();

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    private options: CommitListOptions,
    private readonly handlers: CommitListHandlers
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'intelliGit.commitList',
      `IntelliGit: ${options.title}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = renderTemplate('graphFilterView.hbs', {
      title: options.title,
      hint: options.hint,
      showApply: false
    });

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
        try {
          await this.handleMessage(message as IncomingMessage);
        } catch (error) {
          void vscode.window.showErrorMessage(
            `IntelliGit: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }),
      this.panel.onDidDispose(() => this.dispose())
    );

    this.postInitial();
  }

  static open(options: CommitListOptions, handlers: CommitListHandlers): CommitListView {
    const existing = CommitListView.current.get(options.id);
    if (existing) {
      existing.options = options;
      existing.panel.reveal(vscode.ViewColumn.Active, false);
      existing.postInitial();
      return existing;
    }

    const view = new CommitListView(options, handlers);
    CommitListView.current.set(options.id, view);
    return view;
  }

  private postInitial(): void {
    void this.panel.webview.postMessage({
      type: 'init',
      filters: {},
      branches: collectBranchNames(this.options.branches),
      commits: serializeCommits(this.options.commits)
    });
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (isCommitActionMessage(message)) {
      await handleCommitAction(message);
      return;
    }
    switch (message.type) {
      case 'close':
        this.panel.dispose();
        return;
      case 'openCommitDetails': {
        const sha = message.sha.trim();
        const subject = message.subject.trim();
        if (!sha) {
          return;
        }
        await this.handlers.openCommitDetails(sha, subject);
        return;
      }
      case 'loadCommitFiles': {
        const sha = message.sha.trim();
        if (!sha) {
          return;
        }
        const files = await this.handlers.getCommitFiles(sha);
        void this.panel.webview.postMessage({ type: 'commitFiles', sha, files });
        return;
      }
      case 'openCommitFile': {
        const sha = message.sha.trim();
        const filePath = message.filePath.trim();
        if (!sha || !filePath) {
          return;
        }
        await this.handlers.openFileDiff(sha, filePath);
        return;
      }
    }
  }

  private dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.disposables = [];
    CommitListView.current.delete(this.options.id);
  }
}
