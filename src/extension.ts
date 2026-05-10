import * as vscode from 'vscode';
import { CommandController } from './commands/commandController';
import { EditorOrchestrator } from './editor/editorOrchestrator';
import { GutterDecorationController } from './editor/gutterDecorationController';
import { VirtualGitContentProvider } from './editor/virtualGitContentProvider';
import { Logger } from './logger';
import { BranchTreeProvider } from './providers/branchTreeProvider';
import { CommitFileDecorationProvider } from './providers/commitFileDecorationProvider';
import { CommitFilesTreeProvider } from './providers/commitFilesTreeProvider';
import { GraphCommitTreeItem, GraphTreeProvider } from './providers/graphTreeProvider';
import { StashTreeProvider } from './providers/stashTreeProvider';
import { WorktreeTreeProvider } from './providers/worktreeTreeProvider';
import { SubmoduleTreeProvider } from './providers/submoduleTreeProvider';
import { GitService } from './services/gitService';
import { getRepositoryContext } from './services/repositoryContext';
import { RefreshScope, StateStore } from './state/stateStore';

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
  await vscode.commands.executeCommand('setContext', 'intelliGit.graphMultiCommitSelection', false);

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
      ...compactTreeViews([
        createTreeViewSafely('intelliGit.branches', { treeDataProvider: emptyProvider }, logger),
        createTreeViewSafely('intelliGit.stashes', { treeDataProvider: emptyProvider }, logger),
        createTreeViewSafely('intelliGit.graph', { treeDataProvider: emptyProvider }, logger),
        createTreeViewSafely('intelliGit.commitView', { treeDataProvider: emptyProvider }, logger),
        createTreeViewSafely('intelliGit.worktrees', { treeDataProvider: emptyProvider }, logger),
        createTreeViewSafely('intelliGit.submodules', { treeDataProvider: emptyProvider }, logger)
      ])
    );
    return;
  }

  const gitService = new GitService(repositoryContext, logger, configuration);
  const stateStore = new StateStore(gitService, logger, configuration, context.workspaceState);

  const branchProvider = new BranchTreeProvider(stateStore);
  const stashProvider = new StashTreeProvider(stateStore);
  const graphProvider = new GraphTreeProvider(stateStore, gitService);
  const worktreeProvider = new WorktreeTreeProvider(stateStore);
  const submoduleProvider = new SubmoduleTreeProvider(stateStore);

  const branchView = createTreeViewSafely('intelliGit.branches', {
    treeDataProvider: branchProvider,
    showCollapseAll: true
  }, logger);
  const stashView = createTreeViewSafely('intelliGit.stashes', {
    treeDataProvider: stashProvider,
    showCollapseAll: true
  }, logger);
  const graphView = createTreeViewSafely('intelliGit.graph', {
    treeDataProvider: graphProvider,
    showCollapseAll: true,
    canSelectMany: true
  }, logger);
  const worktreeView = createTreeViewSafely('intelliGit.worktrees', {
    treeDataProvider: worktreeProvider,
    showCollapseAll: true
  }, logger);
  const submoduleView = createTreeViewSafely('intelliGit.submodules', {
    treeDataProvider: submoduleProvider,
    showCollapseAll: true
  }, logger);
  const commitFilesProvider = new CommitFilesTreeProvider(gitService);
  const commitDecorationProvider = new CommitFileDecorationProvider(commitFilesProvider);
  const commitView = createTreeViewSafely('intelliGit.commitView', {
    treeDataProvider: commitFilesProvider,
    showCollapseAll: true,
    canSelectMany: true
  }, logger);

  const virtualProvider = new VirtualGitContentProvider();
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('intelligit', virtualProvider));

  const editor = new EditorOrchestrator(gitService, stateStore, virtualProvider, commitFilesProvider);

  const gutterController = new GutterDecorationController(gitService, stateStore, logger);

  if (graphView) {
    context.subscriptions.push(
      graphView.onDidChangeSelection((event) => {
        const selectedCommitCount = event.selection.filter(
          (item): item is GraphCommitTreeItem => item instanceof GraphCommitTreeItem
        ).length;
        void vscode.commands.executeCommand(
          'setContext',
          'intelliGit.graphMultiCommitSelection',
          selectedCommitCount > 1
        );
      })
    );
  }

  context.subscriptions.push(
    ...[
      gutterController,
      branchView,
      stashView,
      graphView,
      commitView,
      commitDecorationProvider,
      worktreeView,
      submoduleView,
      vscode.window.registerFileDecorationProvider(commitDecorationProvider)
    ].filter((item): item is vscode.Disposable => Boolean(item))
  );
  const commandController = new CommandController(
    gitService,
    stateStore,
    editor,
    logger,
    commitFilesProvider
  );
  commandController.register(context);
  await registerBranchActionHubInGitCheckout(context, logger);

  attachRefreshScopeVisibility(context, branchView, 'refs', stateStore);
  attachRefreshScopeVisibility(context, stashView, 'stashes', stateStore);
  attachRefreshScopeVisibility(context, graphView, 'graph', stateStore);
  attachRefreshScopeVisibility(context, worktreeView, 'worktrees', stateStore);
  attachRefreshScopeVisibility(context, submoduleView, 'submodules', stateStore);

  stateStore.attachAutoRefresh(context);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      // Debounce: rapid saves (e.g. format-on-save + prettier) would otherwise
      // queue multiple back-to-back git-status processes, noticeable on Windows.
      void stateStore.requestRefresh(['changes'], { delayMs: stateStore.getSaveRefreshDebounceMs() });
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await stateStore.refreshVisible();
    })
  );

  logger.info('IntelliGit activated.');
}

export function deactivate(): void {
  // no-op
}

function createTreeViewSafely<T>(
  id: string,
  options: vscode.TreeViewOptions<T>,
  logger: Logger
): vscode.TreeView<T> | undefined {
  try {
    return vscode.window.createTreeView(id, options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/No view is registered with id/i.test(message)) {
      logger.warn(`Skipping tree view registration for ${id}: ${message}. Reload the Extension Development Host if package.json was just changed.`);
      return undefined;
    }
    throw error;
  }
}

function compactTreeViews<T>(views: Array<vscode.TreeView<T> | undefined>): vscode.TreeView<T>[] {
  return views.filter((view): view is vscode.TreeView<T> => Boolean(view));
}

function attachRefreshScopeVisibility<T>(
  context: vscode.ExtensionContext,
  view: vscode.TreeView<T> | undefined,
  scope: RefreshScope,
  stateStore: StateStore
): void {
  if (!view) {
    return;
  }

  stateStore.setRefreshScopeVisible(scope, view.visible);
  context.subscriptions.push(
    view.onDidChangeVisibility((event) => {
      stateStore.setRefreshScopeVisible(scope, event.visible);
    })
  );
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
