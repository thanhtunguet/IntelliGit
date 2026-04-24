import * as vscode from 'vscode';
import { CommandController } from './commands/commandController';
import { EditorOrchestrator } from './editor/editorOrchestrator';
import { GutterDecorationController } from './editor/gutterDecorationController';
import { VirtualGitContentProvider } from './editor/virtualGitContentProvider';
import { Logger } from './logger';
import { BranchTreeProvider } from './providers/branchTreeProvider';
import { ChangeFileTreeItem, ChangesTreeProvider } from './providers/changesTreeProvider';
import { ChangesWebviewProvider } from './providers/changesWebviewProvider';
import { CommitFileDecorationProvider } from './providers/commitFileDecorationProvider';
import { CommitFilesTreeProvider } from './providers/commitFilesTreeProvider';
import { GraphTreeProvider } from './providers/graphTreeProvider';
import { StashTreeProvider } from './providers/stashTreeProvider';
import { GitService } from './services/gitService';
import { getRepositoryContext } from './services/repositoryContext';
import { ChangelistStore } from './state/changelistStore';
import { StateStore } from './state/stateStore';

type GitBaseApi = {
  registerRemoteSourceProvider(provider: {
    name: string;
    getRemoteSources(query?: string): unknown[] | Promise<unknown[]>;
    getRemoteSourceActions?(url: string): {
      label: string;
      icon: string;
      run(branch: string): void;
    }[] | Promise<{
      label: string;
      icon: string;
      run(branch: string): void;
    }[]>;
  }): vscode.Disposable;
};

type GitBaseExtensionExports = {
  getAPI(version: 1): GitBaseApi;
};

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  context.subscriptions.push({ dispose: () => logger.dispose() });
  await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewVisible', false);
  await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanRevertSelected', false);
  await vscode.commands.executeCommand('setContext', 'intelliGit.commitViewCanCherryPickSelected', false);

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
      vscode.window.registerWebviewViewProvider('intelliGit.changes', {
        resolveWebviewView(view) { view.webview.html = '<body style="color:var(--vscode-foreground);padding:8px">Open a workspace to use IntelliGit.</body>'; }
      }),
      vscode.window.createTreeView('intelliGit.stashes', { treeDataProvider: emptyProvider }),
      vscode.window.createTreeView('intelliGit.graph', { treeDataProvider: emptyProvider }),
      vscode.window.createTreeView('intelliGit.commitView', { treeDataProvider: emptyProvider })
    );
    return;
  }

  const gitService = new GitService(repositoryContext, logger, configuration);
  const stateStore = new StateStore(gitService, logger, configuration, context.workspaceState);

  const gitRoot = await gitService.getGitRoot();
  const branchProvider = new BranchTreeProvider(stateStore);
  const changesProvider = new ChangesTreeProvider(stateStore, gitRoot);
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
    showCollapseAll: true,
    canSelectMany: true
  });
  const commitFilesProvider = new CommitFilesTreeProvider(gitService);
  const commitDecorationProvider = new CommitFileDecorationProvider(commitFilesProvider);
  const commitView = vscode.window.createTreeView('intelliGit.commitView', {
    treeDataProvider: commitFilesProvider,
    showCollapseAll: true,
    canSelectMany: true
  });

  const virtualProvider = new VirtualGitContentProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('intelligit', virtualProvider));

  const editor = new EditorOrchestrator(gitService, stateStore, virtualProvider, commitFilesProvider);

  const changelistStore = new ChangelistStore(context.workspaceState);
  const changesWebviewProvider = new ChangesWebviewProvider(context.extensionUri, gitService, stateStore, editor, changelistStore);

  const gutterController = new GutterDecorationController(gitService, stateStore, logger);

  context.subscriptions.push(
    changelistStore,
    gutterController,
    branchView,
    stashView,
    graphView,
    commitView,
    commitDecorationProvider,
    vscode.window.registerFileDecorationProvider(commitDecorationProvider),
    vscode.window.registerWebviewViewProvider('intelliGit.changes', changesWebviewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  const commandController = new CommandController(
    gitService,
    stateStore,
    editor,
    logger,
    commitFilesProvider,
    {
      getSelectedPaths(selectedItems: readonly ChangeFileTreeItem[]): string[] {
        return changesProvider.getSelectedPaths(selectedItems);
      }
    }
  );
  commandController.register(context);
  await registerBranchActionHubInGitCheckout(context, logger);
  context.subscriptions.push(
    vscode.commands.registerCommand('intelliGit.changes.toggleViewMode', () => {
      changesWebviewProvider.toggleViewMode();
    })
  );
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

async function registerBranchActionHubInGitCheckout(
  context: vscode.ExtensionContext,
  logger: Logger
): Promise<void> {
  try {
    const gitBaseExtension = vscode.extensions.getExtension<GitBaseExtensionExports>('vscode.git-base');
    if (!gitBaseExtension) {
      logger.warn('Git Base extension is not available. Branch action hub integration is disabled.');
      return;
    }

    const gitBaseExports = await gitBaseExtension.activate();
    const gitBaseApi = gitBaseExports?.getAPI(1);
    if (!gitBaseApi) {
      logger.warn('Git Base API is unavailable. Branch action hub integration is disabled.');
      return;
    }

    const disposable = gitBaseApi.registerRemoteSourceProvider({
      name: 'IntelliGit Branch Actions',
      getRemoteSources: () => [],
      getRemoteSourceActions: () => ([
        {
          label: 'IntelliGit Branch Action Hub',
          icon: 'tools',
          run(branch: string): void {
            void vscode.commands.executeCommand('intelliGit.branch.actionHub', branch);
          }
        }
      ])
    });

    context.subscriptions.push(disposable);
  } catch (error) {
    logger.warn(`Failed to register IntelliGit branch action hub: ${String(error)}`);
  }
}
