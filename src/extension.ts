import * as vscode from 'vscode';
import { CommandController } from './commands/commandController';
import { EditorOrchestrator } from './editor/editorOrchestrator';
import { VirtualGitContentProvider } from './editor/virtualGitContentProvider';
import { Logger } from './logger';
import { BranchTreeProvider } from './providers/branchTreeProvider';
import { GraphTreeProvider } from './providers/graphTreeProvider';
import { StashTreeProvider } from './providers/stashTreeProvider';
import { GitService } from './services/gitService';
import { getRepositoryContext } from './services/repositoryContext';
import { StateStore } from './state/stateStore';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  context.subscriptions.push({ dispose: () => logger.dispose() });

  let repositoryContext;
  try {
    repositoryContext = getRepositoryContext();
  } catch (error) {
    logger.warn(String(error));
    void vscode.window.showWarningMessage('IntelliGit: Open a workspace folder to enable the extension.');
    return;
  }

  const configuration = vscode.workspace.getConfiguration('intelliGit');
  const gitService = new GitService(repositoryContext, logger, configuration);
  const stateStore = new StateStore(gitService, logger, configuration, context.workspaceState);

  const branchProvider = new BranchTreeProvider(stateStore);
  const stashProvider = new StashTreeProvider(stateStore);
  const graphProvider = new GraphTreeProvider(stateStore, gitService);

  const branchView = vscode.window.createTreeView('intelliGit.branches', {
    treeDataProvider: branchProvider,
    showCollapseAll: true
  });
  const stashView = vscode.window.createTreeView('intelliGit.stashes', {
    treeDataProvider: stashProvider,
    showCollapseAll: true
  });
  const graphView = vscode.window.createTreeView('intelliGit.graph', {
    treeDataProvider: graphProvider,
    showCollapseAll: true
  });

  context.subscriptions.push(branchView, stashView, graphView);

  const virtualProvider = new VirtualGitContentProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('intelligit', virtualProvider));

  const editor = new EditorOrchestrator(gitService, stateStore, context.extensionUri, virtualProvider);
  const commandController = new CommandController(gitService, stateStore, editor, logger, branchProvider);
  commandController.register(context);

  stateStore.attachAutoRefresh(context);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async () => {
      await stateStore.refreshAll();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await stateStore.refreshAll();
    })
  );

  try {
    await stateStore.refreshAll();
    logger.info('IntelliGit activated.');
  } catch (error) {
    logger.error('Initial refresh failed', error);
    void vscode.window.showWarningMessage('IntelliGit activated with partial state. Check output channel for details.');
  }
}

export function deactivate(): void {
  // no-op
}
