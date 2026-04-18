import * as vscode from 'vscode';
import { CommandController } from './commands/commandController';
import { EditorOrchestrator } from './editor/editorOrchestrator';
import { VirtualGitContentProvider } from './editor/virtualGitContentProvider';
import { Logger } from './logger';
import { BranchTreeProvider } from './providers/branchTreeProvider';
import { CommitFileDecorationProvider } from './providers/commitFileDecorationProvider';
import { CommitFilesTreeProvider, CommitFileTreeItem } from './providers/commitFilesTreeProvider';
import { GraphTreeProvider } from './providers/graphTreeProvider';
import { StashTreeProvider } from './providers/stashTreeProvider';
import { GitService } from './services/gitService';
import { getRepositoryContext } from './services/repositoryContext';
import { StateStore } from './state/stateStore';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  context.subscriptions.push({ dispose: () => logger.dispose() });

  const configuration = vscode.workspace.getConfiguration('intelliGit');

  let repositoryContext;
  try {
    repositoryContext = getRepositoryContext();
  } catch (error) {
    logger.warn(String(error));
    void vscode.window.showWarningMessage('IntelliGit: Open a workspace folder to enable the extension.');
  }

  if (!repositoryContext) {
    // Register empty providers so the views appear in the SCM panel.
    // VS Code hides declared views permanently if no data provider is ever registered.
    const emptyProvider: vscode.TreeDataProvider<vscode.TreeItem> = {
      onDidChangeTreeData: new vscode.EventEmitter<void>().event,
      getTreeItem: (el) => el,
      getChildren: () => []
    };
    context.subscriptions.push(
      vscode.window.createTreeView('intelliGit.branches', { treeDataProvider: emptyProvider }),
      vscode.window.createTreeView('intelliGit.stashes', { treeDataProvider: emptyProvider }),
      vscode.window.createTreeView('intelliGit.graph', { treeDataProvider: emptyProvider }),
      vscode.window.createTreeView('intelliGit.commitView', { treeDataProvider: emptyProvider })
    );
    return;
  }

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
  const commitFilesProvider = new CommitFilesTreeProvider(gitService);
  const commitDecorationProvider = new CommitFileDecorationProvider(commitFilesProvider);
  const commitView = vscode.window.createTreeView('intelliGit.commitView', {
    treeDataProvider: commitFilesProvider,
    showCollapseAll: true
  });

  context.subscriptions.push(
    branchView,
    stashView,
    graphView,
    commitView,
    commitDecorationProvider,
    vscode.window.registerFileDecorationProvider(commitDecorationProvider)
  );

  const virtualProvider = new VirtualGitContentProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('intelligit', virtualProvider));

  const editor = new EditorOrchestrator(gitService, stateStore, virtualProvider, commitFilesProvider);
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
