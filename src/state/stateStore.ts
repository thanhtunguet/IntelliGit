import * as vscode from 'vscode';
import { getConfigValue } from '../configuration';
import { Logger } from '../logger';
import { GitService } from '../services/gitService';
import { BranchRef, CommitFilters, ComparePair, CompareResult, GitOperationState, GraphCommit, MergeConflictFile, StashEntry, SubmoduleEntry, TagRef, WorkingTreeChange, WorktreeEntry } from '../types';
import { RefreshScheduler, RefreshScope } from './refreshScheduler';
import { RepoChangeSet } from '../services/repositoryStateDiff';
import { mapChangeSetToScopes } from './gitEventRouter';

export type { RefreshScope } from './refreshScheduler';

const RECENT_COMPARE_PAIRS_KEY = 'vscodeGitClient.recentComparePairs';
const LEGACY_RECENT_COMPARE_PAIRS_KEY = 'intelliGit.recentComparePairs';
const COMPARE_VIEW_MODE_KEY = 'vscodeGitClient.compareViewMode';

export type CompareViewMode = 'list' | 'graph';

function branchesEqual(a: readonly BranchRef[], b: readonly BranchRef[]): boolean {
  if (a.length !== b.length) { return false; }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (
      left.name !== right.name ||
      left.type !== right.type ||
      left.current !== right.current ||
      left.upstream !== right.upstream ||
      left.ahead !== right.ahead ||
      left.behind !== right.behind ||
      left.lastCommitEpoch !== right.lastCommitEpoch
    ) {
      return false;
    }
  }
  return true;
}

function tagsEqual(a: readonly TagRef[], b: readonly TagRef[]): boolean {
  if (a.length !== b.length) { return false; }
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    const leftRemotes = left.availableOnRemotes ?? [];
    const rightRemotes = right.availableOnRemotes ?? [];
    if (
      left.name !== right.name ||
      left.sha !== right.sha ||
      left.lastCommitEpoch !== right.lastCommitEpoch ||
      leftRemotes.length !== rightRemotes.length ||
      leftRemotes.some((r, idx) => r !== rightRemotes[idx])
    ) {
      return false;
    }
  }
  return true;
}

export class StateStore {
  private static readonly DEFAULT_REFRESH_DEBOUNCE_MS = 250;
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
    const persisted = this.workspaceState.get<ComparePair[]>(
      RECENT_COMPARE_PAIRS_KEY,
      this.workspaceState.get<ComparePair[]>(LEGACY_RECENT_COMPARE_PAIRS_KEY, [])
    );
    this._recentComparePairs = Array.isArray(persisted) ? persisted : [];
    if (this._recentComparePairs.length > 0 && !this.workspaceState.get<ComparePair[]>(RECENT_COMPARE_PAIRS_KEY)) {
      void this.workspaceState.update(RECENT_COMPARE_PAIRS_KEY, this._recentComparePairs);
    }
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
    return getConfigValue<number>('performance.saveRefreshDebounceMs', 150);
  }

  private getRefreshDebounceMs(): number {
    return getConfigValue<number>('performance.refreshDebounceMs', StateStore.DEFAULT_REFRESH_DEBOUNCE_MS);
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
    // Phase A — local branches
    let phaseAOk = false;
    try {
      const locals = await this.git.getLocalBranches();
      if (!branchesEqual(this._branches, locals)) {
        this._branches = locals;
        this.emitter.fire();
      }
      phaseAOk = true;
    } catch (error) {
      this.logger.warn(`Failed to load local branches: ${String(error)}`);
    }

    // Phase B — remote branches
    try {
      const remoteUrls = await this.git.getRemoteFetchUrls();
      const remotes = await this.git.getRemoteBranches(remoteUrls);
      const merged = phaseAOk
        ? [...this._branches.filter((b) => b.type === 'local'), ...remotes]
        : remotes;
      merged.sort((a, b) => {
        if (a.current) { return -1; }
        if (b.current) { return 1; }
        if (a.type !== b.type) { return a.type === 'local' ? -1 : 1; }
        return a.name.localeCompare(b.name);
      });
      if (!branchesEqual(this._branches, merged)) {
        this._branches = merged;
        this.emitter.fire();
      }
    } catch (error) {
      this.logger.warn(`Failed to load remote branches: ${String(error)}`);
    }

    // Phase C — tags with remote-availability already merged.
    // Tags are published in a single emit (basic + per-remote availability) so
    // tag icons do not flicker between "no remote" and "available on remotes".
    // If the slower ls-remote step fails, we still publish the basic tag list
    // with empty availability so the section is not blank.
    try {
      const basic = await this.git.getTagsBasic();
      let availability: ReadonlyMap<string, ReadonlySet<string>> = new Map();
      try {
        availability = await this.git.getTagAvailabilityByRemote();
      } catch (error) {
        this.logger.warn(`Failed to compute tag remote availability: ${String(error)}`);
      }
      const enriched = this.git.mergeTagAvailability(basic, availability);
      if (!tagsEqual(this._tags, enriched)) {
        this._tags = enriched;
        this.emitter.fire();
      }
    } catch (error) {
      this.logger.warn(`Failed to load tag list: ${String(error)}`);
    }
  }

  private async loadStashes(): Promise<void> {
    this._stashes = await this.git.getStashes();
  }

  private async loadWorktrees(): Promise<void> {
    this._worktrees = await this.git.getWorktrees().catch(() => []);
  }

  private async loadSubmodules(): Promise<void> {
    this._submodules = await this.git.getSubmodules().catch(() => []);
    void vscode.commands.executeCommand('setContext', 'vscodeGitClient.hasSubmodules', this._submodules.length > 0);
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
    void vscode.commands.executeCommand('setContext', 'vscodeGitClient.operation', operationState.kind);
    void vscode.commands.executeCommand('setContext', 'vscodeGitClient.hasConflicts', conflicts.length > 0);
  }

  async refreshGraph(filters?: CommitFilters): Promise<void> {
    this._graphFilters = filters ? { ...filters } : this._graphFilters;
    await this.requestRefresh(['graph']);
  }

  private async loadGraph(): Promise<void> {
    const maxGraphCommits = getConfigValue<number>('maxGraphCommits', 200);
    this._graph = await this.git.getGraph(maxGraphCommits, 0, this._graphFilters);
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
    let watchersRegistered = false;

    const handleStateChange = (changeSet: RepoChangeSet): void => {
      const scopes = mapChangeSetToScopes(changeSet);
      if (scopes.size === 0) {
        return;
      }
      void this.requestRefresh(scopes, { delayMs: this.getRefreshDebounceMs() });
    };

    const attachStateListener = async (): Promise<void> => {
      const disposable = await this.git.onRepositoryStateChange(handleStateChange);
      if (disposable) {
        context.subscriptions.push(disposable);
      }
    };

    const attachFileWatchers = async (): Promise<void> => {
      if (watchersRegistered) {
        return;
      }
      const gitDir = await this.git.getGitDir();
      if (!gitDir) {
        this.logger.warn(
          'VS Code Git Client: .git directory could not be resolved; ' +
          'stashes/worktrees/submodules will refresh only on view focus.'
        );
        return;
      }
      watchersRegistered = true;

      const gitDirUri = vscode.Uri.file(gitDir);
      const workspaceUri = vscode.Uri.file(this.git.rootPath);

      const watch = (
        base: vscode.Uri,
        pattern: string,
        scopes: RefreshScope[]
      ): vscode.FileSystemWatcher => {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(base, pattern)
        );
        const handler = (): void => {
          void this.requestRefresh(scopes, { delayMs: 250 });
        };
        watcher.onDidCreate(handler);
        watcher.onDidChange(handler);
        watcher.onDidDelete(handler);
        return watcher;
      };

      context.subscriptions.push(
        watch(gitDirUri, 'refs/stash', ['stashes']),
        watch(gitDirUri, 'logs/refs/stash', ['stashes']),
        watch(gitDirUri, 'worktrees/**', ['worktrees']),
        watch(gitDirUri, 'modules/**', ['submodules']),
        watch(workspaceUri, '.gitmodules', ['submodules']),
        watch(gitDirUri, '{MERGE_HEAD,REBASE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD}', ['changes']),
        watch(gitDirUri, 'rebase-merge/**', ['changes']),
        watch(gitDirUri, 'rebase-apply/**', ['changes'])
      );
    };

    // Attach immediately if the repo is already open; re-attach on late open.
    void this.git
      .onRepositoryAvailable(() => {
        void attachStateListener();
        void attachFileWatchers();
      })
      .then((disposable) => {
        if (disposable) {
          context.subscriptions.push(disposable);
        }
      });

    // Reset the registration flag on close so a re-open reinstalls listeners.
    void this.git
      .onRepositoryClosed(() => {
        watchersRegistered = false;
      })
      .then((disposable) => {
        if (disposable) {
          context.subscriptions.push(disposable);
        }
      });
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
    void this.workspaceState.update(RECENT_COMPARE_PAIRS_KEY, this._recentComparePairs);
  }

  getCompareViewMode(): CompareViewMode {
    const raw = this.workspaceState.get<string>(COMPARE_VIEW_MODE_KEY, 'list');
    return raw === 'graph' ? 'graph' : 'list';
  }

  async setCompareViewMode(mode: CompareViewMode): Promise<void> {
    await this.workspaceState.update(COMPARE_VIEW_MODE_KEY, mode);
  }
}
