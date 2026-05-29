import * as vscode from 'vscode';
import { handleCommitAction, isCommitActionMessage, type CommitActionMessage } from './commitActions';
import { collectBranchNames, sanitizeCommitFilters, serializeCommits } from './commitFilterModel';
import { GraphFilterSnapshot } from './graphFilterSession';
import { renderTemplate } from './templateRenderer';
import { BranchRef, CommitFilters, GraphCommit } from '../types';

export interface GraphFilterHandlers {
  apply(filters: CommitFilters): Promise<GraphFilterSnapshot>;
  clear(): Promise<GraphFilterSnapshot>;
  openCommitDetails(sha: string, subject: string): Promise<void>;
  openCommitRangeDetails(shas: readonly string[]): Promise<void>;
  getCommitFiles(sha: string): Promise<string[]>;
  openFileDiff(sha: string, filePath: string): Promise<void>;
  loadMore(): Promise<{ commits: GraphCommit[]; hasMore: boolean }>;
}

type IncomingMessage =
  | { type: 'apply'; filters: CommitFilters; inputRevision?: number }
  | { type: 'clear' }
  | { type: 'close' }
  | { type: 'loadMore' }
  | { type: 'openCommitDetails'; sha: string; subject: string }
  | { type: 'openCommitRangeDetails'; shas: string[] }
  | { type: 'loadCommitFiles'; sha: string }
  | { type: 'openCommitFile'; sha: string; filePath: string }
  | CommitActionMessage;

export class GraphFilterView {
  private static current: GraphFilterView | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private applyRequestId = 0;

  private constructor(
    private readonly handlers: GraphFilterHandlers,
    private readonly getInitial: () => { filters: CommitFilters; branches: BranchRef[]; commits: GraphCommit[]; hasMore: boolean }
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'vscodeGitClient.graphFilter',
      'VS Code Git Client: Filter Graph',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = renderTemplate('graphFilterView.hbs', {
      title: 'Filter Graph',
      hint: 'Inline filters with live commit preview. Click a commit to open its details.',
      showApply: true
    });

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage(async (message: unknown) => {
        try {
          await this.handleMessage(message as IncomingMessage);
        } catch (error) {
          void vscode.window.showErrorMessage(
            `VS Code Git Client: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }),
      this.panel.onDidDispose(() => this.dispose())
    );

    this.postInitial();
  }

  static open(
    handlers: GraphFilterHandlers,
    getInitial: () => { filters: CommitFilters; branches: BranchRef[]; commits: GraphCommit[]; hasMore: boolean }
  ): GraphFilterView {
    if (GraphFilterView.current) {
      GraphFilterView.current.panel.reveal(vscode.ViewColumn.Active, false);
      GraphFilterView.current.postInitial();
      return GraphFilterView.current;
    }
    const view = new GraphFilterView(handlers, getInitial);
    GraphFilterView.current = view;
    return view;
  }

  static async clearCurrentFilters(): Promise<boolean> {
    if (!GraphFilterView.current) {
      return false;
    }
    GraphFilterView.current.applyRequestId++;
    const snapshot = await GraphFilterView.current.handlers.clear();
    GraphFilterView.current.postSnapshot(snapshot);
    return true;
  }

  private postInitial(): void {
    const { filters, branches, commits, hasMore } = this.getInitial();
    this.postSnapshot({ filters, commits, hasMore }, branches);
  }

  private postSnapshot(
    snapshot: GraphFilterSnapshot,
    branches: BranchRef[] = this.getInitial().branches,
    inputRevision?: number
  ): void {
    void this.panel.webview.postMessage({
      type: 'init',
      filters: snapshot.filters,
      branches: collectBranchNames(branches),
      commits: serializeCommits(snapshot.commits),
      hasMore: snapshot.hasMore,
      inputRevision
    });
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (isCommitActionMessage(message)) {
      if (message.action === 'openDetails') {
        const orderedShas = normalizeShas(message.shas ?? [message.sha]);
        if (orderedShas.length > 1) {
          await this.handlers.openCommitRangeDetails(orderedShas);
          return;
        }
      }
      await handleCommitAction(message);
      return;
    }
    switch (message.type) {
      case 'loadMore': {
        try {
          const { commits, hasMore } = await this.handlers.loadMore();
          void this.panel.webview.postMessage({ type: 'appendCommits', commits: serializeCommits(commits), hasMore });
        } catch (error) {
          void vscode.window.showErrorMessage(
            `VS Code Git Client: ${error instanceof Error ? error.message : String(error)}`
          );
          void this.panel.webview.postMessage({ type: 'loadMoreError' });
        }
        return;
      }
      case 'apply': {
        const requestId = ++this.applyRequestId;
        const inputRevision = typeof message.inputRevision === 'number' ? message.inputRevision : undefined;
        const snapshot = await this.handlers.apply(sanitizeCommitFilters(message.filters));
        if (requestId !== this.applyRequestId) {
          return;
        }
        this.postSnapshot(snapshot, undefined, inputRevision);
        return;
      }
      case 'clear':
        this.applyRequestId++;
        this.postSnapshot(await this.handlers.clear());
        return;
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
      case 'openCommitRangeDetails': {
        const orderedShas = normalizeShas(message.shas);
        if (orderedShas.length < 2) {
          return;
        }
        await this.handlers.openCommitRangeDetails(orderedShas);
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
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    if (GraphFilterView.current === this) {
      GraphFilterView.current = undefined;
    }
    void vscode.commands.executeCommand('setContext', 'vscodeGitClient.graphFilterActive', false);
  }
}

function normalizeShas(values: readonly string[]): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
    )
  );
}
