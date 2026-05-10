import * as vscode from 'vscode';
import { Logger } from '../logger';
import { GitService } from '../services/gitService';
import { BranchRef, CommitFilters, ComparePair, CompareResult, GitOperationState, GraphCommit, MergeConflictFile, StashEntry, SubmoduleEntry, TagRef, WorkingTreeChange, WorktreeEntry } from '../types';
import { RefreshScheduler, RefreshScope } from './refreshScheduler';

export type { RefreshScope } from './refreshScheduler';

export class StateStore {
  private static readonly DEFAULT_REFRESH_DEBOUNCE_MS = 250;
  private static readonly DEFAULT_STRUCTURE_REFRESH_DEBOUNCE_MS = 250;
  private _branches: BranchRef[] = [];
  private _tags: TagRef[] = [];
  private _stashes: StashEntry[] = [];
  private _changes: WorkingTreeChange[] = [];
  private _graph: GraphCommit[] = [];
  private _compareResult: CompareResult | undefined;
  private _operationState: GitOperationState = { kind: 'none' };
  private _conflicts: MergeConflictFile[] = [];
  private _recentComparePairs: ComparePair[] = [];
  private _worktrees: WorktreeEntry[] = [];
  private _submodules: SubmoduleEntry[] = [];
  private _graphFilters: CommitFilters = {};
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private _changesRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly visibleScopes = new Set<RefreshScope>();
  private readonly refreshScheduler = new RefreshScheduler((scopes) => this.executeRefresh(scopes));

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

  get tags(): TagRef[] {
    return this._tags;
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

  get graphFilters(): CommitFilters {
    return { ...this._graphFilters };
  }

  get worktrees(): WorktreeEntry[] {
    return this._worktrees;
  }

  get submodules(): SubmoduleEntry[] {
    return this._submodules;
  }

  async refreshAll(): Promise<void> {
    await this.requestRefresh(['full']);
  }

  requestRefresh(scopes: Iterable<RefreshScope>, options?: { delayMs?: number }): Promise<void> {
    return this.refreshScheduler.request(scopes, options);
  }

  getSaveRefreshDebounceMs(): number {
    return this.configuration.get<number>('performance.saveRefreshDebounceMs', 150);
  }

  private getRefreshDebounceMs(): number {
    return this.configuration.get<number>('performance.refreshDebounceMs', StateStore.DEFAULT_REFRESH_DEBOUNCE_MS);
  }

  private getStructureRefreshDebounceMs(): number {
    return this.configuration.get<number>('performance.structureRefreshDebounceMs', StateStore.DEFAULT_STRUCTURE_REFRESH_DEBOUNCE_MS);
  }

  setRefreshScopeVisible(scope: RefreshScope, visible: boolean): void {
    if (scope === 'full') {
      return;
    }
    if (visible) {
      this.visibleScopes.add(scope);
      void this.requestRefresh([scope]);
    } else {
      this.visibleScopes.delete(scope);
    }
  }

  async refreshVisible(): Promise<void> {
    await this.requestRefresh(['full']);
  }

  private async executeRefresh(requestedScopes: ReadonlySet<RefreshScope>): Promise<void> {
    if (!(await this.git.isRepo())) {
      const hadState =
        this._branches.length > 0 ||
        this._tags.length > 0 ||
        this._stashes.length > 0 ||
        this._changes.length > 0 ||
        this._graph.length > 0 ||
        this._compareResult !== undefined ||
        this._operationState.kind !== 'none' ||
        this._conflicts.length > 0 ||
        this._worktrees.length > 0 ||
        this._submodules.length > 0;

      this._branches = [];
      this._tags = [];
      this._stashes = [];
      this._changes = [];
      this._graph = [];
      this._compareResult = undefined;
      this._operationState = { kind: 'none' };
      this._conflicts = [];
      this._worktrees = [];
      this._submodules = [];
      if (hadState) {
        this.emitter.fire();
      }
      return;
    }

    const scopes = this.expandScopes(requestedScopes);
    const previousFingerprint = this.createStateFingerprint(scopes);
    const updates: Array<Promise<void>> = [];

    if (scopes.has('refs')) {
      updates.push(this.loadRefs());
    }
    if (scopes.has('stashes')) {
      updates.push(this.loadStashes());
    }
    if (scopes.has('changes')) {
      updates.push(this.loadChanges());
    }
    if (scopes.has('graph')) {
      updates.push(this.loadGraph());
    }
    if (scopes.has('worktrees')) {
      updates.push(this.loadWorktrees());
    }
    if (scopes.has('submodules')) {
      updates.push(this.loadSubmodules());
    }

    await Promise.all(updates);
    if (this.createStateFingerprint(scopes) !== previousFingerprint) {
      this.emitter.fire();
    }
  }

  async refreshBranches(): Promise<void> {
    await this.requestRefresh(['refs']);
  }

  async refreshStashes(): Promise<void> {
    await this.requestRefresh(['stashes']);
  }

  async refreshWorktrees(): Promise<void> {
    await this.requestRefresh(['worktrees']);
  }

  async refreshSubmodules(): Promise<void> {
    await this.requestRefresh(['submodules']);
  }

  async refreshChanges(): Promise<void> {
    await this.requestRefresh(['changes']);
  }

  private async loadRefs(): Promise<void> {
    const [branches, tags] = await Promise.all([this.git.getBranches(), this.git.getTags()]);
    this._branches = branches;
    this._tags = tags;
  }

  private async loadStashes(): Promise<void> {
    this._stashes = await this.git.getStashes();
  }

  private async loadWorktrees(): Promise<void> {
    this._worktrees = await this.git.getWorktrees().catch(() => []);
  }

  private async loadSubmodules(): Promise<void> {
    this._submodules = await this.git.getSubmodules().catch(() => []);
    void vscode.commands.executeCommand('setContext', 'intelliGit.hasSubmodules', this._submodules.length > 0);
  }

  private async loadChanges(): Promise<void> {
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
  }

  async refreshGraph(filters?: CommitFilters): Promise<void> {
    this._graphFilters = filters ? { ...filters } : this._graphFilters;
    await this.requestRefresh(['graph']);
  }

  private async loadGraph(): Promise<void> {
    const maxGraphCommits = this.configuration.get<number>('maxGraphCommits', 200);
    this._graph = await this.git.getGraph(maxGraphCommits, this._graphFilters);
  }

  async clearGraphFilters(): Promise<void> {
    this._graphFilters = {};
    await this.requestRefresh(['graph']);
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

    const onGitChange = async (uri: vscode.Uri): Promise<void> => {
      try {
        const refreshDebounceMs = this.getRefreshDebounceMs();
        const normalizedPath = uri.fsPath.replace(/\\/g, '/');
        if (normalizedPath.endsWith('/index')) {
          await this.requestRefresh(['changes'], { delayMs: refreshDebounceMs });
          return;
        }

        const scopes: RefreshScope[] = ['refs'];
        if (this.visibleScopes.has('graph')) {
          scopes.push('graph');
        }
        await this.requestRefresh(scopes, { delayMs: refreshDebounceMs });
      } catch (error) {
        this.logger.warn(`Auto-refresh failed: ${String(error)}`);
      }
    };

    gitWatcher.onDidCreate(onGitChange, this, context.subscriptions);
    gitWatcher.onDidChange(onGitChange, this, context.subscriptions);
    gitWatcher.onDidDelete(onGitChange, this, context.subscriptions);
    context.subscriptions.push(gitWatcher);

    void this.git.onDidChangeRepositoryState(() => {
      void this.requestRefresh(['changes'], { delayMs: this.getRefreshDebounceMs() });
    }).then((disposable) => {
      if (disposable) {
        context.subscriptions.push(disposable);
      }
    });

    const worktreeWatcher = vscode.workspace.createFileSystemWatcher('**/.git/worktrees/**');
    const modulesWatcher = vscode.workspace.createFileSystemWatcher('**/.git/modules/**');
    const gitmodulesWatcher = vscode.workspace.createFileSystemWatcher('**/.gitmodules');

    // Debounce worktree/submodule watchers: on Windows, ReadDirectoryChangesW emits
    // multiple events per logical change; without delay each event spawns a git process.
    const onWorktreeChange = async (): Promise<void> => {
      try { await this.requestRefresh(['worktrees'], { delayMs: this.getStructureRefreshDebounceMs() }); } catch (e) { this.logger.warn(`Worktree refresh failed: ${String(e)}`); }
    };
    const onSubmoduleChange = async (): Promise<void> => {
      try { await this.requestRefresh(['submodules'], { delayMs: this.getStructureRefreshDebounceMs() }); } catch (e) { this.logger.warn(`Submodule refresh failed: ${String(e)}`); }
    };

    worktreeWatcher.onDidCreate(onWorktreeChange, this, context.subscriptions);
    worktreeWatcher.onDidChange(onWorktreeChange, this, context.subscriptions);
    worktreeWatcher.onDidDelete(onWorktreeChange, this, context.subscriptions);
    modulesWatcher.onDidCreate(onSubmoduleChange, this, context.subscriptions);
    modulesWatcher.onDidChange(onSubmoduleChange, this, context.subscriptions);
    modulesWatcher.onDidDelete(onSubmoduleChange, this, context.subscriptions);
    gitmodulesWatcher.onDidCreate(onSubmoduleChange, this, context.subscriptions);
    gitmodulesWatcher.onDidChange(onSubmoduleChange, this, context.subscriptions);
    gitmodulesWatcher.onDidDelete(onSubmoduleChange, this, context.subscriptions);

    context.subscriptions.push(worktreeWatcher, modulesWatcher, gitmodulesWatcher);

    // Catch commits made outside VS Code (e.g. terminal, other Git clients):
    // when `files.watcherExclude` blocks .git/index events, the git watcher
    // never fires. Refreshing on window-focus guarantees the badge catches up
    // the moment the user returns to the editor.
    context.subscriptions.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          void this.requestRefresh(['changes'], { delayMs: this.getRefreshDebounceMs() });
        }
      })
    );
  }

  private _scheduleRefreshChanges(): void {
    if (this._changesRefreshTimer) { clearTimeout(this._changesRefreshTimer); }
    this._changesRefreshTimer = setTimeout(() => {
      void this.requestRefresh(['changes']).catch((err) => {
        this.logger.warn(`Auto-refresh changes failed: ${String(err)}`);
      });
    }, 400);
  }

  private expandScopes(requestedScopes: ReadonlySet<RefreshScope>): Set<RefreshScope> {
    const scopes = new Set<RefreshScope>();
    for (const scope of requestedScopes) {
      if (scope !== 'full') {
        scopes.add(scope);
      }
    }

    if (requestedScopes.has('full')) {
      scopes.add('changes');
      scopes.add('refs');
      for (const visibleScope of this.visibleScopes) {
        scopes.add(visibleScope);
      }
    }

    return scopes;
  }

  private createStateFingerprint(scopes: ReadonlySet<RefreshScope>): string {
    const fingerprints: string[] = [];

    if (scopes.has('refs')) {
      fingerprints.push(`refs:${JSON.stringify({ branches: this._branches, tags: this._tags })}`);
    }
    if (scopes.has('stashes')) {
      fingerprints.push(`stashes:${JSON.stringify(this._stashes)}`);
    }
    if (scopes.has('changes')) {
      fingerprints.push(`changes:${JSON.stringify({ changes: this._changes, operation: this._operationState, conflicts: this._conflicts })}`);
    }
    if (scopes.has('graph')) {
      fingerprints.push(`graph:${JSON.stringify(this._graph)}`);
    }
    if (scopes.has('worktrees')) {
      fingerprints.push(`worktrees:${JSON.stringify(this._worktrees)}`);
    }
    if (scopes.has('submodules')) {
      fingerprints.push(`submodules:${JSON.stringify(this._submodules)}`);
    }

    return fingerprints.join('|');
  }

  private pushComparePair(pair: ComparePair): void {
    const key = `${pair.left}:::${pair.right}`;
    this._recentComparePairs = [pair, ...this._recentComparePairs.filter((item) => `${item.left}:::${item.right}` !== key)].slice(0, 10);
    void this.workspaceState.update('intelliGit.recentComparePairs', this._recentComparePairs);
  }
}
