import * as vscode from 'vscode';
import { handleCommitAction, isCommitActionMessage, type CommitActionMessage } from './commitActions';
import { renderTemplate } from './templateRenderer';
import { BranchRef, GraphCommit } from '../types';

export interface GraphFilters {
  branch?: string;
  author?: string;
  message?: string;
  since?: string;
  until?: string;
}

export interface GraphFilterHandlers {
  apply(filters: GraphFilters): Promise<void>;
  clear(): Promise<void>;
}

type IncomingMessage =
  | { type: 'apply'; filters: GraphFilters }
  | { type: 'clear' }
  | { type: 'close' }
  | CommitActionMessage;

export class GraphFilterView {
  private static current: GraphFilterView | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly handlers: GraphFilterHandlers,
    private readonly getInitial: () => { filters: GraphFilters; branches: BranchRef[]; commits: GraphCommit[] }
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'intelliGit.graphFilter',
      'IntelliGit: Filter Graph',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = renderTemplate('graphFilterView.hbs');

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

  static open(
    handlers: GraphFilterHandlers,
    getInitial: () => { filters: GraphFilters; branches: BranchRef[]; commits: GraphCommit[] }
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

  private postInitial(): void {
    const { filters, branches, commits } = this.getInitial();
    const branchNames = Array.from(new Set(branches.map((b) => b.name))).sort();
    void this.panel.webview.postMessage({
      type: 'init',
      filters,
      branches: branchNames,
      commits: commits.map((commit) => ({
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        author: commit.author,
        date: commit.date,
        refs: commit.refs,
        graph: commit.graph
      }))
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
      case 'apply':
        await this.handlers.apply(sanitize(message.filters));
        this.panel.dispose();
        return;
      case 'clear':
        await this.handlers.clear();
        this.panel.dispose();
        return;
      case 'close':
        this.panel.dispose();
        return;
    }
  }

  private dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    if (GraphFilterView.current === this) {
      GraphFilterView.current = undefined;
    }
  }
}

function sanitize(filters: GraphFilters): GraphFilters {
  const trim = (v: string | undefined): string | undefined => {
    const t = (v ?? '').trim();
    return t.length > 0 ? t : undefined;
  };
  return {
    branch: trim(filters.branch),
    author: trim(filters.author),
    message: trim(filters.message),
    since: trim(filters.since),
    until: trim(filters.until)
  };
}
