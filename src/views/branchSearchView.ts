import * as vscode from 'vscode';
import {
  isBranchContextMenuCommand,
  renderBranchContextMenu,
  type BranchContextMenuCommand
} from './branchContextMenu';
import { renderTemplate } from './templateRenderer';
import { BranchRef, TagRef } from '../types';

export interface BranchSearchHandlers {
  checkout(name: string): Promise<void>;
  checkoutTag(name: string): Promise<void>;
  openActions(name: string): Promise<void>;
  runCommand(command: BranchContextMenuCommand, name: string): Promise<void>;
}

type IncomingMessage =
  | { type: 'checkout'; name: string }
  | { type: 'checkoutTag'; name: string }
  | { type: 'actions'; name: string }
  | { type: 'tagActions'; name: string }
  | { type: 'branchCommand'; command: string; name: string }
  | { type: 'tagCommand'; command: string; name: string }
  | { type: 'close' };

export class BranchSearchView {
  private static current: BranchSearchView | undefined;

  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly handlers: BranchSearchHandlers,
    private readonly getBranches: () => BranchRef[],
    private readonly getTags: () => TagRef[],
    onStateChange: (listener: () => void) => vscode.Disposable
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'intelliGit.branchSearch',
      'IntelliGit: Search Branches & Tags',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = renderTemplate('branchSearchView.hbs', {
      branchContextMenuHtml: renderBranchContextMenu()
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
      onStateChange(() => this.postData()),
      this.panel.onDidDispose(() => this.dispose())
    );

    this.postData();
  }

  static open(
    handlers: BranchSearchHandlers,
    getBranches: () => BranchRef[],
    getTags: () => TagRef[],
    onStateChange: (listener: () => void) => vscode.Disposable
  ): BranchSearchView {
    if (BranchSearchView.current) {
      BranchSearchView.current.panel.reveal(vscode.ViewColumn.Active, false);
      return BranchSearchView.current;
    }
    const view = new BranchSearchView(handlers, getBranches, getTags, onStateChange);
    BranchSearchView.current = view;
    return view;
  }

  private postData(): void {
    const branchPayload = this.getBranches().map((branch) => ({
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
    const tagPayload = this.getTags().map((tag) => ({
      name: tag.name,
      fullName: tag.fullName,
      sha: tag.sha,
      lastCommitEpoch: tag.lastCommitEpoch
    }));
    void this.panel.webview.postMessage({ type: 'data', branches: branchPayload, tags: tagPayload });
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
      case 'checkoutTag':
        await this.handlers.checkoutTag(message.name);
        this.panel.dispose();
        return;
      case 'actions':
        await this.handlers.openActions(message.name);
        return;
      case 'tagActions':
        await this.handlers.openActions(message.name);
        return;
      case 'branchCommand':
        if (isBranchContextMenuCommand(message.command)) {
          await this.handlers.runCommand(message.command, message.name);
        }
        return;
      case 'tagCommand':
        if (isBranchContextMenuCommand(message.command)) {
          await this.handlers.runCommand(message.command, message.name);
        }
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
