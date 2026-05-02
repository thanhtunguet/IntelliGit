import * as vscode from 'vscode';
import { renderTemplate } from './templateRenderer';
import { BranchRef } from '../types';

export interface BranchSearchHandlers {
  checkout(name: string): Promise<void>;
  openActions(name: string): Promise<void>;
}

type IncomingMessage =
  | { type: 'checkout'; name: string }
  | { type: 'actions'; name: string }
  | { type: 'close' };

export class BranchSearchView {
  private static current: BranchSearchView | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly handlers: BranchSearchHandlers,
    private readonly getBranches: () => BranchRef[],
    onStateChange: (listener: () => void) => vscode.Disposable
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'intelliGit.branchSearch',
      'IntelliGit: Search Branches',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = renderTemplate('branchSearchView.hbs');

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
      onStateChange(() => this.postBranches()),
      this.panel.onDidDispose(() => this.dispose())
    );

    this.postBranches();
  }

  static open(
    handlers: BranchSearchHandlers,
    getBranches: () => BranchRef[],
    onStateChange: (listener: () => void) => vscode.Disposable
  ): BranchSearchView {
    if (BranchSearchView.current) {
      BranchSearchView.current.panel.reveal(vscode.ViewColumn.Active, false);
      return BranchSearchView.current;
    }
    const view = new BranchSearchView(handlers, getBranches, onStateChange);
    BranchSearchView.current = view;
    return view;
  }

  private postBranches(): void {
    const payload = this.getBranches().map((branch) => ({
      name: branch.name,
      shortName: branch.shortName,
      fullName: branch.fullName,
      type: branch.type,
      remoteName: branch.remoteName,
      upstream: branch.upstream,
      ahead: branch.ahead,
      behind: branch.behind,
      current: branch.current,
      lastCommitEpoch: branch.lastCommitEpoch
    }));
    void this.panel.webview.postMessage({ type: 'branches', branches: payload });
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
    switch (message.type) {
      case 'checkout':
        await this.handlers.checkout(message.name);
        this.panel.dispose();
        return;
      case 'actions':
        await this.handlers.openActions(message.name);
        return;
      case 'close':
        this.panel.dispose();
        return;
    }
  }

  private dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    if (BranchSearchView.current === this) {
      BranchSearchView.current = undefined;
    }
  }
}
