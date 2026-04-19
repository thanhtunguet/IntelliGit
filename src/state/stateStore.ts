import * as vscode from 'vscode';
import { Logger } from '../logger';
import { GitService } from '../services/gitService';
import { BranchRef, ComparePair, CompareResult, GitOperationState, GraphCommit, MergeConflictFile, StashEntry, WorkingTreeChange } from '../types';

export class StateStore {
  private _branches: BranchRef[] = [];
  private _stashes: StashEntry[] = [];
  private _changes: WorkingTreeChange[] = [];
  private _graph: GraphCommit[] = [];
  private _compareResult: CompareResult | undefined;
  private _operationState: GitOperationState = { kind: 'none' };
  private _conflicts: MergeConflictFile[] = [];
  private _recentComparePairs: ComparePair[] = [];
  private _graphFilters: {
    branch?: string;
    author?: string;
    message?: string;
    since?: string;
    until?: string;
  } = {};
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private _changesRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly git: GitService,
    private readonly logger: Logger,
    private readonly configuration: vscode.WorkspaceConfiguration,
    private readonly workspaceState: vscode.Memento
  ) {
    const persisted = this.workspaceState.get<ComparePair[]>('intelliGit.recentComparePairs', []);
    this._recentComparePairs = Array.isArray(persisted) ? persisted : [];
  }

  get branches(): BranchRef[] {
    return this._branches;
  }

  get stashes(): StashEntry[] {
    return this._stashes;
  }

  get changes(): WorkingTreeChange[] {
    return this._changes;
  }

  get stagedChanges(): WorkingTreeChange[] {
    return this._changes.filter((c) => c.status[0] !== ' ' && c.status[0] !== '?');
  }

  get unstagedChanges(): WorkingTreeChange[] {
    return this._changes.filter((c) => c.status[1] !== ' ');
  }

  get graph(): GraphCommit[] {
    return this._graph;
  }

  get compareResult(): CompareResult | undefined {
    return this._compareResult;
  }

  get operationState(): GitOperationState {
    return this._operationState;
  }

  get conflicts(): MergeConflictFile[] {
    return this._conflicts;
  }

  get recentComparePairs(): ComparePair[] {
    return [...this._recentComparePairs];
  }

  get graphFilters(): {
    branch?: string;
    author?: string;
    message?: string;
    since?: string;
    until?: string;
  } {
    return { ...this._graphFilters };
  }

  async refreshAll(): Promise<void> {
    if (!(await this.git.isRepo())) {
      this._branches = [];
      this._stashes = [];
      this._changes = [];
      this._graph = [];
      this._compareResult = undefined;
      this._operationState = { kind: 'none' };
      this._conflicts = [];
      this.emitter.fire();
      return;
    }

    const maxGraphCommits = this.configuration.get<number>('maxGraphCommits', 200);

    const [branches, stashes, changes, graph, operationState, conflicts] = await Promise.all([
      this.git.getBranches(),
      this.git.getStashes(),
      this.git.getChangedFiles(),
      this.git.getGraph(maxGraphCommits, this._graphFilters),
      this.git.getOperationState(),
      this.git.getMergeConflicts()
    ]);

    this._branches = branches;
    this._stashes = stashes;
    this._changes = changes;
    this._graph = graph;
    this._operationState = operationState;
    this._conflicts = conflicts;
    void vscode.commands.executeCommand('setContext', 'intelliGit.operation', operationState.kind);
    void vscode.commands.executeCommand('setContext', 'intelliGit.hasConflicts', conflicts.length > 0);
    this.emitter.fire();
  }

  async refreshBranches(): Promise<void> {
    this._branches = await this.git.getBranches();
    this.emitter.fire();
  }

  async refreshStashes(): Promise<void> {
    this._stashes = await this.git.getStashes();
    this.emitter.fire();
  }

  async refreshChanges(): Promise<void> {
    const [changes, operationState, conflicts] = await Promise.all([
      this.git.getChangedFiles(),
      this.git.getOperationState(),
      this.git.getMergeConflicts()
    ]);
    this._changes = changes;
    this._operationState = operationState;
    this._conflicts = conflicts;
    void vscode.commands.executeCommand('setContext', 'intelliGit.operation', operationState.kind);
    void vscode.commands.executeCommand('setContext', 'intelliGit.hasConflicts', conflicts.length > 0);
    this.emitter.fire();
  }

  async refreshGraph(filters?: {
    branch?: string;
    author?: string;
    message?: string;
    since?: string;
    until?: string;
  }): Promise<void> {
    this._graphFilters = filters ? { ...filters } : this._graphFilters;
    const maxGraphCommits = this.configuration.get<number>('maxGraphCommits', 200);
    this._graph = await this.git.getGraph(maxGraphCommits, this._graphFilters);
    this.emitter.fire();
  }

  async clearGraphFilters(): Promise<void> {
    this._graphFilters = {};
    const maxGraphCommits = this.configuration.get<number>('maxGraphCommits', 200);
    this._graph = await this.git.getGraph(maxGraphCommits);
    this.emitter.fire();
  }

  async compareBranches(leftRef: string, rightRef: string): Promise<CompareResult> {
    const result = await this.git.getCompare(leftRef, rightRef);
    this._compareResult = result;
    this.pushComparePair({ left: leftRef, right: rightRef });
    this.emitter.fire();
    return result;
  }

  clearCompareResult(): void {
    this._compareResult = undefined;
    this.emitter.fire();
  }

  attachAutoRefresh(context: vscode.ExtensionContext): void {
    const gitWatcher = vscode.workspace.createFileSystemWatcher('**/.git/{HEAD,index,refs/**,packed-refs,logs/**}');

    const onChange = async (): Promise<void> => {
      try {
        await this.refreshAll();
      } catch (error) {
        this.logger.warn(`Auto-refresh failed: ${String(error)}`);
      }
    };

    gitWatcher.onDidCreate(onChange, this, context.subscriptions);
    gitWatcher.onDidChange(onChange, this, context.subscriptions);
    gitWatcher.onDidDelete(onChange, this, context.subscriptions);
    context.subscriptions.push(gitWatcher);

    // Catch commits made outside VS Code (e.g. terminal, other Git clients):
    // when `files.watcherExclude` blocks .git/index events, the git watcher
    // never fires. Refreshing on window-focus guarantees the badge catches up
    // the moment the user returns to the editor.
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          void onChange();
        }
      })
    );

    // Watch for new/deleted/modified files in the workspace to catch untracked changes.
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      const workspaceWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folders[0], '**/*')
      );
      const scheduleChanges = (): void => { this._scheduleRefreshChanges(); };
      workspaceWatcher.onDidCreate(scheduleChanges, this, context.subscriptions);
      workspaceWatcher.onDidDelete(scheduleChanges, this, context.subscriptions);
      workspaceWatcher.onDidChange(scheduleChanges, this, context.subscriptions);
      context.subscriptions.push(workspaceWatcher);
    }
  }

  private _scheduleRefreshChanges(): void {
    if (this._changesRefreshTimer) { clearTimeout(this._changesRefreshTimer); }
    this._changesRefreshTimer = setTimeout(() => {
      void this.refreshChanges().catch((err) => {
        this.logger.warn(`Auto-refresh changes failed: ${String(err)}`);
      });
    }, 400);
  }

  private pushComparePair(pair: ComparePair): void {
    const key = `${pair.left}:::${pair.right}`;
    this._recentComparePairs = [pair, ...this._recentComparePairs.filter((item) => `${item.left}:::${item.right}` !== key)].slice(0, 10);
    void this.workspaceState.update('intelliGit.recentComparePairs', this._recentComparePairs);
  }
}
