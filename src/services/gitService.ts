import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfigValue } from '../configuration';
import { Logger } from '../logger';
import { GitCommandQueue } from './gitCommandQueue';
import {
  BranchRef,
  CommitFilters,
  CommitDetails,
  CommitFileChange,
  CompareResult,
  GitCommandResult,
  GitOperationState,
  GraphCommit,
  MergeConflictFile,
  RepositoryContext,
  ResolvedCommitMeta,
  StashEntry,
  TagRef,
  WorkingTreeChange,
  WorkingTreeFileChange,
  WorktreeEntry,
  WorktreePruneEntry,
  WorktreeStatus,
  SubmoduleEntry
} from '../types';
import { SubmoduleService } from './submoduleService';
import { parseWorktreeListPorcelain, parseWorktreePruneDryRun } from './worktreeParsing';
import { parseTrack, parseNameStatusZ, parsePorcelainStatusZ } from './gitParsing';
import {
  buildRepositoryFingerprint,
  diffRepositoryFingerprints,
  isEmptyChangeSet,
  RepoChangeSet,
  RepositoryFingerprint
} from './repositoryStateDiff';

export type { RepoChangeSet } from './repositoryStateDiff';

const FIELD_SEPARATOR = '|~|';
const RECORD_SEPARATOR = '|#|';

interface VsCodeGitChange {
  readonly uri: vscode.Uri;
}

interface VsCodeGitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: {
      readonly name?: string;
      readonly commit?: string;
    };
    readonly indexChanges: readonly VsCodeGitChange[];
    readonly mergeChanges: readonly VsCodeGitChange[];
    readonly workingTreeChanges: readonly VsCodeGitChange[];
    readonly untrackedChanges: readonly VsCodeGitChange[];
    readonly onDidChange?: vscode.Event<void>;
  };
  status(): Promise<void>;
  add(paths: string[]): Promise<void>;
  restore(paths: string[], options?: { staged?: boolean; ref?: string }): Promise<void>;
  revert(paths: string[]): Promise<void>;
  clean(paths: string[]): Promise<void>;
  createBranch(name: string, checkout: boolean, ref?: string): Promise<void>;
  deleteBranch(name: string, force?: boolean): Promise<void>;
  setBranchUpstream(name: string, upstream: string): Promise<void>;
  checkout(treeish: string): Promise<void>;
  tag(name: string, message: string, ref?: string): Promise<void>;
  fetch(options?: { prune?: boolean }): Promise<void>;
  pull(unshallow?: boolean): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
  commit(message: string, opts?: { all?: boolean | 'tracked'; amend?: boolean }): Promise<void>;
  rebase(branch: string): Promise<void>;
  mergeAbort(): Promise<void>;
  createStash(options?: { message?: string; includeUntracked?: boolean; staged?: boolean }): Promise<void>;
}

interface VsCodeGitApi {
  readonly repositories: readonly VsCodeGitRepository[];
  getRepository(uri: vscode.Uri): VsCodeGitRepository | null;
  getRepositoryRoot(uri: vscode.Uri): Promise<vscode.Uri | null>;
  openRepository(root: vscode.Uri): Promise<VsCodeGitRepository | null>;
  readonly onDidOpenRepository?: vscode.Event<VsCodeGitRepository>;
  readonly onDidCloseRepository?: vscode.Event<VsCodeGitRepository>;
}

interface VsCodeGitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): VsCodeGitApi;
}

export class GitService {
  private _gitRootCache: string | undefined;
  private _vscodeGitApi: Promise<VsCodeGitApi | undefined> | undefined;
  private _vscodeGitRepository: VsCodeGitRepository | undefined;
  private readonly gitCommandQueue = new GitCommandQueue(process.platform === 'win32' ? 2 : 4);

  private static readonly BRANCH_FORMAT = [
    '%(refname:short)',
    '%(refname)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(HEAD)',
    '%(committerdate:unix)'
  ].join(FIELD_SEPARATOR);

  private static readonly BRANCH_SORT_COMPARATOR = (a: BranchRef, b: BranchRef): number => {
    if (a.current) { return -1; }
    if (b.current) { return 1; }
    if (a.type !== b.type) { return a.type === 'local' ? -1 : 1; }
    return a.name.localeCompare(b.name);
  };

  private static readonly TAG_FORMAT = [
    '%(refname:short)',
    '%(refname)',
    '%(objectname)',
    '%(*objectname)',
    '%(creatordate:unix)'
  ].join(FIELD_SEPARATOR);

  private static readonly TAG_SORT_COMPARATOR = (a: TagRef, b: TagRef): number => {
    const left = a.lastCommitEpoch ?? 0;
    const right = b.lastCommitEpoch ?? 0;
    if (left !== right) { return right - left; }
    return a.name.localeCompare(b.name);
  };

  constructor(
    private readonly context: RepositoryContext,
    private readonly logger: Logger,
    private readonly config: vscode.WorkspaceConfiguration
  ) { }

  get rootPath(): string {
    return this.context.rootPath;
  }

  /**
   * Synchronous accessor for the resolved git root. Falls back to the workspace
   * root until {@link getGitRoot} has populated the cache (done during activate).
   * All path arguments passed to git commands must be relative to this path.
   */
  get gitRoot(): string {
    return this._gitRootCache ?? this.context.rootPath;
  }

  async getGitRoot(): Promise<string> {
    if (this._gitRootCache !== undefined) {
      return this._gitRootCache;
    }
    try {
      const result = await this.runGit(['rev-parse', '--show-toplevel']);
      this._gitRootCache = result.stdout.trim();
    } catch {
      this._gitRootCache = this.context.rootPath;
    }
    return this._gitRootCache;
  }

  /**
   * Converts an absolute fsPath to a git-root-relative path with forward slashes,
   * suitable for passing to any git command (pathspec or index lookup).
   * Returns undefined if the path is outside the git root.
   */
  toRepoRelative(absolutePath: string): string | undefined {
    const rel = path.relative(this.gitRoot, absolutePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      return undefined;
    }
    return rel.split(path.sep).join('/');
  }

  async isRepo(): Promise<boolean> {
    const vscodeGitRoot = await this.getVsCodeGitRoot();
    if (vscodeGitRoot) {
      return true;
    }
    try {
      const result = await this.runGit(['rev-parse', '--is-inside-work-tree']);
      return result.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async getCurrentBranch(): Promise<string> {
    const repository = await this.getVsCodeRepository();
    if (repository?.state.HEAD?.name) {
      return repository.state.HEAD.name;
    }
    const result = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.stdout.trim();
  }

  async getCurrentHeadSha(): Promise<string> {
    const repository = await this.getVsCodeRepository();
    if (repository?.state.HEAD?.commit) {
      return repository.state.HEAD.commit;
    }
    const result = await this.runGit(['rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  async getLocalBranches(): Promise<BranchRef[]> {
    const result = await this.runGit([
      'for-each-ref',
      `--format=${GitService.BRANCH_FORMAT}${RECORD_SEPARATOR}`,
      'refs/heads'
    ]);
    return this.parseBranchLines(result.stdout, new Map()).sort(GitService.BRANCH_SORT_COMPARATOR);
  }

  async getRemoteBranches(remoteUrls: Map<string, string>): Promise<BranchRef[]> {
    const result = await this.runGit([
      'for-each-ref',
      `--format=${GitService.BRANCH_FORMAT}${RECORD_SEPARATOR}`,
      'refs/remotes'
    ]);
    return this.parseBranchLines(result.stdout, remoteUrls).sort(GitService.BRANCH_SORT_COMPARATOR);
  }

  async getBranches(): Promise<BranchRef[]> {
    const remoteUrls = await this.getRemoteFetchUrls();
    const [locals, remotes] = await Promise.all([
      this.getLocalBranches(),
      this.getRemoteBranches(remoteUrls)
    ]);
    return [...locals, ...remotes].sort(GitService.BRANCH_SORT_COMPARATOR);
  }

  private parseBranchLines(stdout: string, remoteUrls: Map<string, string>): BranchRef[] {
    return stdout
      .split(RECORD_SEPARATOR)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, fullName, upstream, track, head, commitEpochRaw] = line.split(FIELD_SEPARATOR);
        const { ahead, behind } = parseTrack(track || '');
        const type: 'local' | 'remote' = fullName.startsWith('refs/remotes/') ? 'remote' : 'local';
        const shortName = type === 'remote' ? name.replace(/^[^/]+\//, '') : name;
        const remoteName = type === 'remote' ? name.split('/')[0] : undefined;
        const commitEpoch = Number.parseInt((commitEpochRaw ?? '').trim(), 10);
        return {
          name,
          shortName,
          fullName,
          type,
          remoteName,
          remoteUrl: remoteName ? remoteUrls.get(remoteName) : undefined,
          upstream: upstream || undefined,
          ahead,
          behind,
          current: head === '*',
          lastCommitEpoch: Number.isNaN(commitEpoch) ? undefined : commitEpoch
        };
      })
      .filter((branch) => {
        // Drop remote root refs like "origin" (no slash).
        return branch.type !== 'remote' || branch.name.includes('/');
      });
  }

  async getRemoteFetchUrls(): Promise<Map<string, string>> {
    try {
      const result = await this.runGit(['remote', '-v']);
      const urls = new Map<string, string>();
      for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.trim().match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
        if (!match) {
          continue;
        }
        const [, remoteName, remoteUrl, mode] = match;
        if (mode !== 'fetch' || urls.has(remoteName)) {
          continue;
        }
        urls.set(remoteName, remoteUrl);
      }
      return urls;
    } catch {
      return new Map<string, string>();
    }
  }

  async getTagsBasic(): Promise<TagRef[]> {
    const result = await this.runGit([
      'for-each-ref',
      `--format=${GitService.TAG_FORMAT}${RECORD_SEPARATOR}`,
      'refs/tags'
    ]);
    return result.stdout
      .split(RECORD_SEPARATOR)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, fullName, objectSha, peeledSha, commitEpochRaw] = line.split(FIELD_SEPARATOR);
        const commitEpoch = Number.parseInt((commitEpochRaw ?? '').trim(), 10);
        return {
          name,
          fullName,
          sha: peeledSha || objectSha || undefined,
          availableOnRemotes: [] as string[],
          lastCommitEpoch: Number.isNaN(commitEpoch) ? undefined : commitEpoch
        };
      })
      .sort(GitService.TAG_SORT_COMPARATOR);
  }

  mergeTagAvailability(
    tags: readonly TagRef[],
    availability: ReadonlyMap<string, ReadonlySet<string>>
  ): TagRef[] {
    return tags.map((tag) => ({
      ...tag,
      availableOnRemotes: Array.from(availability.get(tag.name) ?? []).sort((a, b) =>
        a.localeCompare(b)
      )
    }));
  }

  async getTags(): Promise<TagRef[]> {
    const [basic, availability] = await Promise.all([
      this.getTagsBasic(),
      this.getTagAvailabilityByRemote()
    ]);
    return this.mergeTagAvailability(basic, availability);
  }

  async getTagAvailabilityByRemote(): Promise<Map<string, Set<string>>> {
    const resultMap = new Map<string, Set<string>>();
    try {
      const remoteUrls = await this.getRemoteFetchUrls();
      const remotes = Array.from(remoteUrls.keys()).sort((a, b) => a.localeCompare(b));
      for (const remote of remotes) {
        let output = '';
        try {
          output = (await this.runGit(['ls-remote', '--tags', remote])).stdout;
        } catch {
          continue;
        }
        for (const line of output.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          const [, ref] = trimmed.split(/\s+/, 2);
          if (!ref?.startsWith('refs/tags/')) {
            continue;
          }
          const tagName = ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '');
          const remotesForTag = resultMap.get(tagName) ?? new Set<string>();
          remotesForTag.add(remote);
          resultMap.set(tagName, remotesForTag);
        }
      }
    } catch {
      return resultMap;
    }
    return resultMap;
  }

  async createBranch(name: string, base?: string): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info(`vscode.git createBranch ${name}${base ? ` ${base}` : ''}`);
      await repository.createBranch(name, false, base);
      return;
    }
    const args = ['branch', name];
    if (base) {
      args.push(base);
    }
    await this.runGit(args);
  }

  async createTag(name: string, ref: string): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info(`vscode.git tag ${name} ${ref}`);
      await repository.tag(name, '', ref);
      return;
    }
    await this.runGit(['tag', name, ref]);
  }

  async setRemoteUrl(remoteName: string, remoteUrl: string): Promise<void> {
    await this.runGit(['remote', 'set-url', remoteName, remoteUrl]);
  }

  async addRemote(remoteName: string, remoteUrl: string): Promise<void> {
    await this.runGit(['remote', 'add', remoteName, remoteUrl]);
  }

  async renameBranch(from: string, to: string): Promise<void> {
    await this.runGit(['branch', '-m', from, to]);
  }

  async deleteBranch(branch: string, force = false): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info(`vscode.git deleteBranch ${branch}${force ? ' --force' : ''}`);
      await repository.deleteBranch(branch, force);
      return;
    }
    await this.runGit(['branch', force ? '-D' : '-d', branch]);
  }

  async checkoutBranch(branch: string): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info(`vscode.git checkout ${branch}`);
      await repository.checkout(branch);
      return;
    }
    await this.runGit(['checkout', branch]);
  }

  async checkoutCommit(commit: string): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info(`vscode.git checkout ${commit}`);
      await repository.checkout(commit);
      return;
    }
    await this.runGit(['checkout', commit]);
  }

  async trackBranch(localBranch: string, upstream: string): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info(`vscode.git setBranchUpstream ${localBranch} ${upstream}`);
      await repository.setBranchUpstream(localBranch, upstream);
      return;
    }
    await this.runGit(['branch', '--set-upstream-to', upstream, localBranch]);
  }

  async untrackBranch(localBranch: string): Promise<void> {
    await this.runGit(['branch', '--unset-upstream', localBranch]);
  }

  async mergeIntoCurrent(branch: string): Promise<void> {
    await this.runGit(['merge', '--no-ff', branch]);
  }

  async rebaseCurrentOnto(branch: string): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info(`vscode.git rebase ${branch}`);
      await repository.rebase(branch);
      return;
    }
    await this.runGit(['rebase', branch]);
  }

  async rebaseInteractive(base: string): Promise<void> {
    await this.runGit(['rebase', '-i', base]);
  }

  async mergeAbort(): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info('vscode.git mergeAbort');
      await repository.mergeAbort();
      return;
    }
    await this.runGit(['merge', '--abort']);
  }

  async rebaseAbort(): Promise<void> {
    await this.runGit(['rebase', '--abort']);
  }

  async rebaseContinue(): Promise<void> {
    await this.runGit(['-c', 'core.editor=true', 'rebase', '--continue']);
  }

  async rebaseSkip(): Promise<void> {
    await this.runGit(['rebase', '--skip']);
  }

  async cherryPickAbort(): Promise<void> {
    await this.runGit(['cherry-pick', '--abort']);
  }

  async cherryPickContinue(): Promise<void> {
    await this.runGit(['-c', 'core.editor=true', 'cherry-pick', '--continue']);
  }

  async cherryPickSkip(): Promise<void> {
    await this.runGit(['cherry-pick', '--skip']);
  }

  async revertAbort(): Promise<void> {
    await this.runGit(['revert', '--abort']);
  }

  async revertContinue(): Promise<void> {
    await this.runGit(['-c', 'core.editor=true', 'revert', '--continue']);
  }

  async resolveConflictOurs(path: string): Promise<void> {
    await this.runGit(['checkout', '--ours', '--', path]);
    await this.runGit(['add', '--', path]);
  }

  async resolveConflictTheirs(path: string): Promise<void> {
    await this.runGit(['checkout', '--theirs', '--', path]);
    await this.runGit(['add', '--', path]);
  }

  async getOperationState(): Promise<GitOperationState> {
    const gitDir = await this.getGitDir();
    if (!gitDir) {
      return { kind: 'none' };
    }

    const readFile = async (relative: string): Promise<string | undefined> => {
      try {
        const uri = vscode.Uri.file(`${gitDir}/${relative}`);
        const bytes = await vscode.workspace.fs.readFile(uri);
        return Buffer.from(bytes).toString('utf8').trim();
      } catch {
        return undefined;
      }
    };

    const exists = async (relative: string): Promise<boolean> => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(`${gitDir}/${relative}`));
        return true;
      } catch {
        return false;
      }
    };

    const shortenRef = async (value?: string): Promise<string | undefined> => {
      if (!value) { return undefined; }
      try {
        const result = await this.runGit(['rev-parse', '--short', value]);
        return result.stdout.trim() || value.slice(0, 8);
      } catch {
        return value.slice(0, 8);
      }
    };

    // Run all existence checks in parallel to avoid sequential FS round-trips.
    // On Windows each stat goes through Defender; sequential calls add up to 50-250 ms.
    const [hasMergeRebase, hasApplyRebase, hasMergeHead, hasCherryPick, hasRevert] =
      await Promise.all([
        exists('rebase-merge'),
        exists('rebase-apply'),
        exists('MERGE_HEAD'),
        exists('CHERRY_PICK_HEAD'),
        exists('REVERT_HEAD'),
      ]);

    // Rebase: interactive/merge backend
    if (hasMergeRebase) {
      const [head, onto, msgnum, end] = await Promise.all([
        readFile('rebase-merge/head-name'),
        readFile('rebase-merge/onto'),
        readFile('rebase-merge/msgnum'),
        readFile('rebase-merge/end')
      ]);
      return {
        kind: 'rebase',
        headShort: head?.replace(/^refs\/heads\//, ''),
        ontoShort: await shortenRef(onto),
        stepCurrent: msgnum ? Number(msgnum) : undefined,
        stepTotal: end ? Number(end) : undefined
      };
    }

    // Rebase: apply backend
    if (hasApplyRebase) {
      const [head, onto, next, last] = await Promise.all([
        readFile('rebase-apply/head-name'),
        readFile('rebase-apply/onto'),
        readFile('rebase-apply/next'),
        readFile('rebase-apply/last')
      ]);
      return {
        kind: 'rebase',
        headShort: head?.replace(/^refs\/heads\//, ''),
        ontoShort: await shortenRef(onto),
        stepCurrent: next ? Number(next) : undefined,
        stepTotal: last ? Number(last) : undefined
      };
    }

    if (hasMergeHead) {
      const [mergeHead, mergeMsg] = await Promise.all([
        readFile('MERGE_HEAD'),
        readFile('MERGE_MSG')
      ]);
      return {
        kind: 'merge',
        headShort: await shortenRef(mergeHead?.split('\n')[0]),
        message: mergeMsg?.split('\n')[0]
      };
    }

    if (hasCherryPick) {
      const head = await readFile('CHERRY_PICK_HEAD');
      return { kind: 'cherry-pick', headShort: await shortenRef(head) };
    }

    if (hasRevert) {
      const head = await readFile('REVERT_HEAD');
      return { kind: 'revert', headShort: await shortenRef(head) };
    }

    return { kind: 'none' };
  }

  private _gitDirCache: string | undefined;

  private _submoduleService: SubmoduleService | undefined;

  private get submoduleSvc(): SubmoduleService {
    if (!this._submoduleService) {
      this._submoduleService = new SubmoduleService(
        this.config,
        this.gitRoot,
        this.runGit.bind(this)
      );
    }
    return this._submoduleService;
  }

  private async getVsCodeGitApi(): Promise<VsCodeGitApi | undefined> {
    if (!this._vscodeGitApi) {
      this._vscodeGitApi = (async () => {
        const extension = vscode.extensions.getExtension<VsCodeGitExtension>('vscode.git');
        if (!extension) {
          return undefined;
        }
        const gitExtension = extension.isActive ? extension.exports : await extension.activate();
        if (!gitExtension.enabled) {
          return undefined;
        }
        return gitExtension.getAPI(1);
      })();
    }
    return this._vscodeGitApi;
  }

  private async getVsCodeGitRoot(): Promise<string | undefined> {
    try {
      const api = await this.getVsCodeGitApi();
      const rootUri = await api?.getRepositoryRoot(this.context.rootUri);
      return rootUri?.fsPath;
    } catch {
      return undefined;
    }
  }

  private async getVsCodeRepository(): Promise<VsCodeGitRepository | undefined> {
    const rootUri = vscode.Uri.file(this.gitRoot);
    if (this._vscodeGitRepository && this.samePath(this._vscodeGitRepository.rootUri.fsPath, rootUri.fsPath)) {
      return this._vscodeGitRepository;
    }

    const api = await this.getVsCodeGitApi();
    if (!api) {
      return undefined;
    }

    const repository =
      api.getRepository(rootUri) ??
      api.repositories.find((candidate) => this.samePath(candidate.rootUri.fsPath, rootUri.fsPath)) ??
      await api.openRepository(rootUri);
    if (!repository) {
      return undefined;
    }

    this._vscodeGitRepository = repository;
    return repository;
  }

  /**
   * Subscribe to VS Code Git API repository state changes with scope-aware
   * diffing. The listener is invoked only when the diff is non-empty — VS Code
   * fires {@code state.onDidChange} redundantly, and the redundant events
   * would otherwise spawn no-op refreshes.
   */
  async onRepositoryStateChange(
    listener: (changeSet: RepoChangeSet) => void
  ): Promise<vscode.Disposable | undefined> {
    const repository = await this.getVsCodeRepository();
    if (!repository?.state.onDidChange) {
      return undefined;
    }
    let last: RepositoryFingerprint = buildRepositoryFingerprint(repository.state);
    return repository.state.onDidChange(() => {
      const next = buildRepositoryFingerprint(repository.state);
      const changeSet = diffRepositoryFingerprints(last, next);
      last = next;
      if (isEmptyChangeSet(changeSet)) {
        return;
      }
      listener(changeSet);
    });
  }

  /**
   * Fires {@code listener} immediately if our repository is already open, then
   * each time the VS Code Git API reports our repository being (re)opened.
   * Lets consumers attach state listeners and watchers even when {@code vscode.git}
   * activates after our extension.
   */
  async onRepositoryAvailable(listener: () => void): Promise<vscode.Disposable | undefined> {
    const api = await this.getVsCodeGitApi();
    if (!api) {
      return undefined;
    }
    const current = await this.getVsCodeRepository();
    if (current) {
      listener();
    }
    if (!api.onDidOpenRepository) {
      return undefined;
    }
    return api.onDidOpenRepository((repo) => {
      if (this.samePath(repo.rootUri.fsPath, this.gitRoot)) {
        this._vscodeGitRepository = repo;
        listener();
      }
    });
  }

  /**
   * Fires {@code listener} when our repository is closed by VS Code (e.g.
   * workspace folder removed). Clears the cached repository handle so a
   * subsequent {@link onRepositoryAvailable} can re-attach.
   */
  async onRepositoryClosed(listener: () => void): Promise<vscode.Disposable | undefined> {
    const api = await this.getVsCodeGitApi();
    if (!api?.onDidCloseRepository) {
      return undefined;
    }
    return api.onDidCloseRepository((repo) => {
      if (this.samePath(repo.rootUri.fsPath, this.gitRoot)) {
        this._vscodeGitRepository = undefined;
        listener();
      }
    });
  }

  private toAbsoluteRepoPath(relativeOrAbsolutePath: string): string {
    return path.isAbsolute(relativeOrAbsolutePath)
      ? relativeOrAbsolutePath
      : path.join(this.gitRoot, relativeOrAbsolutePath);
  }

  private uniqueChangePaths(changes: readonly VsCodeGitChange[]): string[] {
    return [...new Set(changes.map((change) => change.uri.fsPath))];
  }

  private async getChangedFilesFromVsCodeGit(): Promise<WorkingTreeChange[] | undefined> {
    const repository = await this.getVsCodeRepository();
    if (!repository) {
      return undefined;
    }

    const changes = new Map<string, string>();
    const setStatus = (change: VsCodeGitChange, status: string): void => {
      const relativePath = this.toRepoRelative(change.uri.fsPath);
      if (!relativePath) {
        return;
      }

      if (status === '??' || status === 'UU') {
        changes.set(relativePath, status);
        return;
      }

      const existing = changes.get(relativePath) ?? '  ';
      const next = [
        status[0] !== ' ' ? status[0] : existing[0],
        status[1] !== ' ' ? status[1] : existing[1]
      ].join('');
      changes.set(relativePath, next);
    };

    repository.state.indexChanges.forEach((change) => setStatus(change, 'M '));
    repository.state.workingTreeChanges.forEach((change) => setStatus(change, ' M'));
    repository.state.untrackedChanges.forEach((change) => setStatus(change, '??'));
    repository.state.mergeChanges.forEach((change) => setStatus(change, 'UU'));

    return [...changes.entries()]
      .map(([path, status]) => ({ path, status }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private samePath(left: string, right: string): boolean {
    const normalizedLeft = path.normalize(left);
    const normalizedRight = path.normalize(right);
    return process.platform === 'win32'
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  }

  async getGitDir(): Promise<string | undefined> {
    if (this._gitDirCache) { return this._gitDirCache; }
    try {
      const result = await this.runGit(['rev-parse', '--git-dir']);
      const raw = result.stdout.trim();
      if (!raw) { return undefined; }
      const resolved = path.isAbsolute(raw) ? raw : path.join(this.gitRoot, raw);
      this._gitDirCache = resolved;
      return resolved;
    } catch {
      return undefined;
    }
  }

  async cherryPick(ref: string): Promise<void> {
    await this.runGit(['cherry-pick', ref]);
  }

  async cherryPickCommitFiles(ref: string, filePaths: string[]): Promise<void> {
    await this.applyCommitFilesPatch(ref, filePaths, false);
  }

  async cherryPickRange(fromExclusive: string, toInclusive: string): Promise<void> {
    await this.runGit(['cherry-pick', `${fromExclusive}..${toInclusive}`]);
  }

  async revertCommit(ref: string): Promise<void> {
    await this.runGit(['revert', ref]);
  }

  async revertCommitFiles(ref: string, filePaths: string[]): Promise<void> {
    await this.applyCommitFilesPatch(ref, filePaths, true);
  }

  async resetCurrent(ref: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    await this.runGit(['reset', `--${mode}`, ref]);
  }

  async isCommitInCurrentBranch(sha: string): Promise<boolean> {
    try {
      await this.runGit(['merge-base', '--is-ancestor', sha, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  async getStashes(): Promise<StashEntry[]> {
    let result: GitCommandResult;
    try {
      result = await this.runGit([
        'reflog',
        'show',
        'refs/stash',
        '--date=iso-strict',
        `--format=%gd${FIELD_SEPARATOR}%H${FIELD_SEPARATOR}%gs${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${RECORD_SEPARATOR}`
      ]);
    } catch {
      return [];
    }
    const lines = result.stdout
      .split(RECORD_SEPARATOR)
      .map((line) => line.trim())
      .filter(Boolean);

    const entries: StashEntry[] = [];
    for (const line of lines) {
      const [refRaw, sha, subject, author, timestamp] = line.split(FIELD_SEPARATOR);
      const refMatch = refRaw.match(/^stash@\{(\d+)\}$/);
      const index = Number(refMatch?.[1] ?? entries.length);
      const ref = `stash@{${index}}`;
      const message = subject.replace(/^(?:On|WIP on)\s+[^:]+:\s*/, '').trim() || subject;
      entries.push({
        index,
        ref,
        message: message || subject,
        author: author || undefined,
        timestamp: timestamp || undefined,
        sha: sha || undefined
      });
    }

    return entries.sort((a, b) => a.index - b.index);
  }

  async createStash(message: string, options: { includeUntracked: boolean; keepIndex: boolean }): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository && !options.keepIndex) {
      this.logger.info(`vscode.git createStash ${message}`);
      await repository.createStash({ message, includeUntracked: options.includeUntracked });
      return;
    }

    const args = ['stash', 'push', '-m', message];
    if (options.includeUntracked) {
      args.push('-u');
    }
    if (options.keepIndex) {
      args.push('--keep-index');
    }
    await this.runGit(args);
  }

  async applyStash(ref: string, pop = false): Promise<void> {
    await this.runGit(['stash', pop ? 'pop' : 'apply', ref]);
  }

  async dropStash(ref: string): Promise<void> {
    await this.runGit(['stash', 'drop', ref]);
  }

  async renameStash(ref: string, message: string): Promise<void> {
    const stashHash = (await this.runGit(['rev-parse', ref])).stdout.trim();
    await this.runGit(['stash', 'drop', ref]);
    await this.runGit(['stash', 'store', '-m', message, stashHash]);
  }

  async getStashPatch(ref: string): Promise<string> {
    const result = await this.runGit(['stash', 'show', '-p', ref]);
    return result.stdout;
  }

  async getGraph(maxCount: number, filters?: CommitFilters): Promise<GraphCommit[]> {
    const format = [
      '%m',
      '%H',
      '%h',
      '%P',
      '%D',
      '%an',
      '%aI',
      '%s'
    ].join(FIELD_SEPARATOR);

    const args = ['log', '--date=iso-strict', '--decorate=full', `--max-count=${maxCount}`, `--format=${format}${RECORD_SEPARATOR}`];

    if (filters?.branch) {
      args.push(filters.branch);
    }
    if (filters?.author) {
      args.push(`--author=${filters.author}`);
    }
    if (filters?.message) {
      args.push(`--grep=${filters.message}`);
    }
    if (filters?.since) {
      args.push(`--since=${filters.since}`);
    }
    if (filters?.until) {
      args.push(`--until=${filters.until}`);
    }

    const result = await this.runGit(args);

    return result.stdout
      .split(RECORD_SEPARATOR)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [graph, sha, shortSha, parentsRaw, refsRaw, author, date, subject] = line.split(FIELD_SEPARATOR);
        const parents = parentsRaw?.split(' ').filter(Boolean) ?? [];
        const refs = refsRaw
          ? refsRaw
            .split(',')
            .map((ref) => ref.trim())
            .filter(Boolean)
          : [];
        return {
          graph,
          sha,
          shortSha,
          parents,
          refs,
          author,
          date,
          subject
        } as GraphCommit;
      });
  }

  async getCommitDetails(sha: string): Promise<CommitDetails> {
    const [commit] = await this.getGraph(1, { branch: sha });
    const bodyResult = await this.runGit(['show', '--quiet', '--format=%B', sha]);
    const nameStatus = await this.runGit(['show', '--name-status', '--format=', sha]);
    const shortStatResult = await this.runGit(['show', '--shortstat', '--format=', sha]);
    const changedFiles = nameStatus.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split('\t');
        return { status, path };
      });

    const stats = parseShortStat(shortStatResult.stdout);

    return {
      commit: {
        ...commit,
        stats
      },
      body: bodyResult.stdout.trim(),
      changedFiles
    };
  }

  async getParentCommit(sha: string): Promise<string | undefined> {
    const result = await this.runGit(['rev-list', '--parents', '-n', '1', sha]);
    const tokens = result.stdout
      .trim()
      .split(/\s+/)
      .filter(Boolean);

    if (tokens.length < 2) {
      return undefined;
    }

    return tokens[1];
  }

  async getFilesAtRevision(ref: string): Promise<string[]> {
    const result = await this.runGit(['ls-tree', '-r', '--name-only', ref]);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async getPatchForCommit(sha: string): Promise<string> {
    const result = await this.runGit(['format-patch', '--stdout', '-1', sha]);
    return result.stdout;
  }

  async getPatchForCommitFiles(sha: string, filePaths: string[]): Promise<string> {
    if (filePaths.length === 0) {
      return '';
    }

    const result = await this.runGit(['show', '--binary', '--format=', sha, '--', ...filePaths]);
    return result.stdout;
  }

  async canApplyPatchToWorkingTree(patch: string): Promise<boolean> {
    if (!patch.trim()) {
      return false;
    }

    try {
      await this.runGitWithStdin(['apply', '--check', '--3way', '--whitespace=nowarn'], patch);
      return true;
    } catch {
      return false;
    }
  }

  async isPatchAlreadyApplied(patch: string): Promise<boolean> {
    if (!patch.trim()) {
      return false;
    }

    try {
      await this.runGitWithStdin(['apply', '--check', '--reverse', '--whitespace=nowarn'], patch);
      return true;
    } catch {
      return false;
    }
  }

  async applyPatchToWorkingTree(patch: string): Promise<void> {
    if (!patch.trim()) {
      return;
    }

    await this.runGitWithStdin(['apply', '--3way', '--whitespace=nowarn'], patch);
  }

  async getCompare(leftRef: string, rightRef: string): Promise<CompareResult> {
    const leftOnly = await this.runGit([
      'log',
      '--date=iso-strict',
      `--format=%m${FIELD_SEPARATOR}%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%D${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`,
      `${rightRef}..${leftRef}`
    ]);
    const rightOnly = await this.runGit([
      'log',
      '--date=iso-strict',
      `--format=%m${FIELD_SEPARATOR}%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%D${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`,
      `${leftRef}..${rightRef}`
    ]);

    const diffNames = await this.runGit(['diff', '--name-status', `${leftRef}...${rightRef}`]);

    const mergeBase = await this.tryGetMergeBaseCommit(leftRef, rightRef);

    return {
      leftRef,
      rightRef,
      commitsOnlyLeft: parseGraphRows(leftOnly.stdout),
      commitsOnlyRight: parseGraphRows(rightOnly.stdout),
      mergeBase,
      changedFiles: diffNames.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [status, path] = line.split('\t');
          return {
            status,
            path
          };
        })
    };
  }

  private async tryGetMergeBaseCommit(leftRef: string, rightRef: string): Promise<GraphCommit | undefined> {
    try {
      const base = await this.runGit(['merge-base', leftRef, rightRef]);
      const sha = base.stdout.trim();
      if (!sha) {
        return undefined;
      }
      const detail = await this.runGit([
        'log',
        '-1',
        '--date=iso-strict',
        `--format=%m${FIELD_SEPARATOR}%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%D${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`,
        sha
      ]);
      const [parsed] = parseGraphRows(detail.stdout);
      return parsed;
    } catch {
      return undefined;
    }
  }

  async getChangedFiles(): Promise<WorkingTreeChange[]> {
    const vscodeGitChanges = await this.getChangedFilesFromVsCodeGit();
    if (vscodeGitChanges) {
      return vscodeGitChanges;
    }

    const result = await this.runGit(['status', '--porcelain=v1', '-z']);
    return parsePorcelainStatusZ(result.stdout);
  }

  async stashFiles(
    paths: string[],
    message: string,
    options: { keepIndex: boolean; includeUntracked?: boolean }
  ): Promise<void> {
    const filtered = [...new Set(paths.map((value) => value.trim()).filter(Boolean))];
    if (filtered.length === 0) {
      return;
    }

    const args = ['stash', 'push', '-m', message];
    if (options.keepIndex) {
      args.push('--keep-index');
    }
    if (options.includeUntracked) {
      args.push('--include-untracked');
    }
    args.push('--', ...filtered);
    await this.runGit(args);
  }

  async unstashToWorkingTree(ref: string): Promise<void> {
    await this.runGit(['stash', 'pop', ref]);
  }

  async getStagedFiles(): Promise<string[]> {
    const result = await this.runGit(['diff', '--cached', '--name-only']);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async getMergeConflicts(): Promise<MergeConflictFile[]> {
    const result = await this.runGit(['diff', '--name-status', '--diff-filter=U']);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [status, path] = line.split('\t');
        return { status, path };
      });
  }

  async getFileContentFromRef(refSpec: string, relativePath: string): Promise<string> {
    if (refSpec === 'WORKTREE') {
      try {
        const gitRoot = await this.getGitRoot();
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(path.join(gitRoot, relativePath)));
        return Buffer.from(bytes).toString('utf8');
      } catch (error) {
        if (this.isMissingFileContentError(error)) {
          return '';
        }
        throw error;
      }
    }

    try {
      if (refSpec === 'INDEX') {
        const result = await this.runGit(['show', `:${relativePath}`]);
        return result.stdout;
      }

      const result = await this.runGit(['show', `${refSpec}:${relativePath}`]);
      return result.stdout;
    } catch (error) {
      if (this.isMissingFileContentError(error)) {
        return '';
      }
      throw error;
    }
  }

  private isMissingFileContentError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      /EntryNotFound|ENOENT|no such file or directory/i.test(message) ||
      /does not exist in|exists on disk, but not in|not in the index/i.test(message)
    );
  }

  async getFilesInCommit(sha: string): Promise<string[]> {
    const entries = await this.getFilesInCommitWithStatus(sha);
    return entries.map((entry) => entry.path);
  }

  async getFilesInCommitWithStatus(sha: string): Promise<CommitFileChange[]> {
    const result = await this.runGit(['show', '--name-status', '--pretty=format:', sha]);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t').filter(Boolean);
        const statusRaw = parts[0] ?? '';
        const pathRaw = parts.at(-1) ?? '';
        const status = (statusRaw ?? '').trim();
        const path = (pathRaw ?? '').trim();
        return { status, path };
      })
      .filter((entry) => Boolean(entry.path));
  }

  async getFilesChangedBetween(leftRef: string, rightRef: string): Promise<string[]> {
    const result = await this.runGit(['diff', '--name-only', `${leftRef}...${rightRef}`]);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async getFilesChangedBetweenRefsWithStatus(fromRef: string, toRef: string): Promise<CommitFileChange[]> {
    const result = await this.runGit(['diff', '--name-status', fromRef, toRef]);
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split('\t').filter(Boolean);
        const statusRaw = parts[0] ?? '';
        const pathRaw = parts.at(-1) ?? '';
        const status = (statusRaw ?? '').trim();
        const path = (pathRaw ?? '').trim();
        return { status, path };
      })
      .filter((entry) => Boolean(entry.path));
  }

  /**
   * Returns all files that differ between the working tree and the given ref.
   * Includes tracked files (via `git diff --name-status -z <ref>`) plus
   * untracked files (via `git ls-files --others --exclude-standard -z`).
   * When `scopePath` is provided, results are restricted to that subtree.
   * Results are sorted by path for stable output.
   */
  async getFilesChangedBetweenWorkingTreeAndRef(ref: string, scopePath?: string): Promise<WorkingTreeFileChange[]> {
    const scopeArgs = scopePath ? ['--', scopePath] : [];

    // Tracked changes
    const trackedResult = await this.runGit([
      'diff', '--name-status', '-z', ref, ...scopeArgs
    ]);
    const trackedEntries = parseNameStatusZ(trackedResult.stdout).map(
      (entry): WorkingTreeFileChange => ({ status: entry.status, path: entry.path, untracked: false })
    );

    // Untracked files
    const untrackedResult = await this.runGit([
      'ls-files', '--others', '--exclude-standard', '-z', ...scopeArgs
    ]);
    const untrackedEntries: WorkingTreeFileChange[] = untrackedResult.stdout
      .split('\0')
      .filter((p) => p.length > 0)
      .map((p): WorkingTreeFileChange => ({ status: 'A', path: p, untracked: true }));

    // Merge: prefer tracked entry when path appears in both
    const trackedPaths = new Set(trackedEntries.map((e) => e.path));
    const merged = [
      ...trackedEntries,
      ...untrackedEntries.filter((e) => !trackedPaths.has(e.path))
    ];

    // Stable sort by path
    merged.sort((a, b) => a.path.localeCompare(b.path));
    return merged;
  }

  /**
   * Resolves a revision expression (branch name, tag, short SHA, etc.) to
   * a commit and returns its metadata. Returns `undefined` when the ref is
   * invalid or git fails for any reason — this method never throws.
   */
  async resolveRevisionToCommit(input: string): Promise<ResolvedCommitMeta | undefined> {
    try {
      const verifyResult = await this.runGit(['rev-parse', '--verify', `${input}^{commit}`]);
      const sha = verifyResult.stdout.trim();
      if (!sha) {
        return undefined;
      }

      // Fetch metadata in one log call using NUL separators
      const logResult = await this.runGit([
        'log', '-1', '--format=%H%x00%s%x00%an%x00%ad', '--date=iso-strict', sha
      ]);
      const parts = logResult.stdout.trim().split('\0');
      if (parts.length < 4) {
        return undefined;
      }
      const [resolvedSha, subject, author, date] = parts;
      if (!resolvedSha || !subject || !author || !date) {
        return undefined;
      }
      return { sha: resolvedSha, subject, author, date };
    } catch {
      return undefined;
    }
  }

  async stageFile(path: string): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info(`vscode.git add ${path}`);
      await repository.add([this.toAbsoluteRepoPath(path)]);
      return;
    }
    await this.runGit(['add', '--', path]);
  }

  async unstageFile(path: string): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info(`vscode.git restore --staged ${path}`);
      await repository.restore([this.toAbsoluteRepoPath(path)], { staged: true });
      return;
    }
    await this.runGit(['restore', '--staged', '--', path]);
  }

  async getOutgoingIncomingPreview(): Promise<{ outgoing: string[]; incoming: string[] }> {
    const branch = await this.getCurrentBranch();
    let upstreamName = '';
    try {
      const upstream = await this.runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{upstream}`]);
      upstreamName = upstream.stdout.trim();
    } catch {
      return { outgoing: [], incoming: [] };
    }

    const outgoingResult = await this.runGit(['log', '--oneline', `${upstreamName}..${branch}`]);
    const incomingResult = await this.runGit(['log', '--oneline', `${branch}..${upstreamName}`]);

    return {
      outgoing: outgoingResult.stdout.split('\n').map((l) => l.trim()).filter(Boolean),
      incoming: incomingResult.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
    };
  }

  async push(): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info('vscode.git push');
      await repository.push();
      return;
    }
    await this.runGit(['push']);
  }

  async pull(): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info('vscode.git pull');
      await repository.pull();
      return;
    }
    await this.runGit(['pull']);
  }

  async fetchPrune(): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info('vscode.git fetch --prune');
      await repository.fetch({ prune: true });
      return;
    }
    await this.runGit(['fetch', '--prune']);
  }

  async addAll(): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info('vscode.git add all');
      await repository.status();
      const paths = this.uniqueChangePaths([
        ...repository.state.mergeChanges,
        ...repository.state.workingTreeChanges,
        ...repository.state.untrackedChanges
      ]);
      if (paths.length > 0) {
        await repository.add(paths);
      }
      return;
    }
    await this.runGit(['add', '-A']);
  }

  async stagePatch(filePath: string): Promise<void> {
    await this.runGit(['add', '-p', '--', filePath]);
  }

  async amendCommit(message?: string): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info(`vscode.git commit --amend${message ? ' -m <message>' : ' --no-edit'}`);
      await repository.commit(message ?? '', { amend: true });
      return;
    }
    const args = ['commit', '--amend'];
    if (message) {
      args.push('-m', message);
    } else {
      args.push('--no-edit');
    }
    await this.runGit(args);
  }

  async commit(message: string): Promise<void> {
    const repository = await this.getVsCodeRepository();
    if (repository) {
      this.logger.info('vscode.git commit -m <message>');
      await repository.commit(message);
      return;
    }
    await this.runGit(['commit', '-m', message]);
  }

  async getHeadCommitMessage(): Promise<string> {
    const result = await this.runGit(['log', '-1', '--pretty=%B']);
    return result.stdout.trim();
  }

  async generateCommitMessage(token?: vscode.CancellationToken): Promise<string> {
    let diff = '';
    try {
      const staged = await this.runGit(['diff', '--staged']);
      diff = staged.stdout;
    } catch { /* ignore */ }

    if (!diff.trim()) {
      try {
        const unstaged = await this.runGit(['diff']);
        diff = unstaged.stdout;
      } catch { /* ignore */ }
    }

    if (!diff.trim()) {
      throw new Error('No changes to generate a commit message from.');
    }

    const maxLen = 8000;
    const truncated = diff.length > maxLen ? diff.slice(0, maxLen) + '\n... (diff truncated)' : diff;

    const preferredFamilies = ['gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'gpt-4', 'claude-3.5-sonnet'];
    let model: vscode.LanguageModelChat | undefined;
    for (const family of preferredFamilies) {
      const [m] = await vscode.lm.selectChatModels({ family });
      if (m) { model = m; break; }
    }
    if (!model) {
      const [any] = await vscode.lm.selectChatModels();
      model = any;
    }
    if (!model) {
      throw new Error('No AI model available. Install GitHub Copilot or another AI extension to enable this feature.');
    }

    const cts = new vscode.CancellationTokenSource();
    if (token) {
      token.onCancellationRequested(() => cts.cancel());
    }
    const messages = [
      vscode.LanguageModelChatMessage.User(
        `Write a concise git commit message (imperative mood, 50 chars or less for the subject line) for this diff. Output only the commit message, nothing else:\n\n${truncated}`
      )
    ];

    const response = await model.sendRequest(messages, {}, cts.token);
    let result = '';
    for await (const chunk of response.text) {
      result += chunk;
    }
    return result.trim();
  }

  async fileHistory(path: string): Promise<GraphCommit[]> {
    const format = `%m${FIELD_SEPARATOR}%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%P${FIELD_SEPARATOR}%D${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s${RECORD_SEPARATOR}`;
    const result = await this.runGit(['log', '--date=iso-strict', '--follow', `--format=${format}`, '--', path]);
    return parseGraphRows(result.stdout);
  }

  async fileBlame(path: string): Promise<string> {
    const result = await this.runGit(['blame', '--', path]);
    return result.stdout;
  }

  async openMergeEditor(filePath: string): Promise<void> {
    const outputUri = vscode.Uri.file(path.join(this.gitRoot, filePath));
    try {
      const [base, ours, theirs] = await Promise.all([
        this.getFileStageContent(1, filePath),
        this.getFileStageContent(2, filePath),
        this.getFileStageContent(3, filePath)
      ]);

      const tmpDir = os.tmpdir();
      const safe = path.basename(filePath).replace(/[^a-zA-Z0-9._-]/g, '_');
      const writeTemp = (suffix: string, content: string): vscode.Uri => {
        const tmpPath = path.join(tmpDir, `vscodegitclient_${safe}_${suffix}`);
        fs.writeFileSync(tmpPath, content, 'utf8');
        return vscode.Uri.file(tmpPath);
      };

      await vscode.commands.executeCommand('mergeEditor.openInput', {
        base: { uri: writeTemp('base', base), title: 'Base' },
        input1: { uri: writeTemp('ours', ours), title: 'Yours (Current Branch)', description: filePath },
        input2: { uri: writeTemp('theirs', theirs), title: 'Theirs (Incoming)', description: filePath },
        output: outputUri
      });
      await this.applyMergeEditorColumnLayout();
    } catch {
      await vscode.commands.executeCommand('vscode.openWith', outputUri, 'mergeEditor');
      await this.applyMergeEditorColumnLayout();
    }
  }

  private async applyMergeEditorColumnLayout(): Promise<void> {
    const commandCandidates = [
      'merge.columnLayout',
      'mergeEditor.setColumnLayout',
      'workbench.action.mergeEditor.setColumnLayout'
    ];
    for (const cmd of commandCandidates) {
      try {
        await vscode.commands.executeCommand(cmd);
        return;
      } catch {
        // try next candidate
      }
    }
  }

  async getFileStageContent(stage: 1 | 2 | 3, filePath: string): Promise<string> {
    const result = await this.runGit(['show', `:${stage}:${filePath}`]);
    return result.stdout;
  }

  async getWorktrees(): Promise<WorktreeEntry[]> {
    const result = await this.runGit(['worktree', 'list', '--porcelain']);
    const raw = parseWorktreeListPorcelain(result.stdout);
    const currentPath = this.gitRoot;

    return Promise.all(
      raw.map(async (w) => {
        let status: WorktreeStatus = { isDirty: false, ahead: 0, behind: 0 };
        let headSubject: string | undefined;
        try {
          status = await this.getWorktreeStatus(w.worktreePath);
          const logResult = await this.runGitAt(w.worktreePath, ['log', '-1', '--format=%s']);
          headSubject = logResult.stdout.trim() || undefined;
        } catch { /* worktree may be unavailable */ }
        return {
          ...w,
          isCurrent: w.worktreePath === currentPath,
          isDirty: status.isDirty,
          ahead: status.ahead,
          behind: status.behind,
          headSubject
        };
      })
    );
  }

  async addWorktree(worktreePath: string, ref: string): Promise<void> {
    await this.runGit(['worktree', 'add', worktreePath, ref]);
  }

  async addWorktreeBranch(worktreePath: string, branch: string, base?: string): Promise<void> {
    const args = ['worktree', 'add', '-b', branch, worktreePath];
    if (base) { args.push(base); }
    await this.runGit(args);
  }

  async addDetachedWorktree(worktreePath: string, ref: string): Promise<void> {
    await this.runGit(['worktree', 'add', '--detach', worktreePath, ref]);
  }

  async removeWorktree(worktreePath: string, force = false): Promise<void> {
    const args = ['worktree', 'remove', worktreePath];
    if (force) { args.push('--force'); }
    await this.runGit(args);
  }

  async lockWorktree(worktreePath: string, reason?: string): Promise<void> {
    const args = ['worktree', 'lock', worktreePath];
    if (reason) { args.push('--reason', reason); }
    await this.runGit(args);
  }

  async unlockWorktree(worktreePath: string): Promise<void> {
    await this.runGit(['worktree', 'unlock', worktreePath]);
  }

  async getPrunableWorktrees(): Promise<WorktreePruneEntry[]> {
    const result = await this.runGit(['worktree', 'prune', '--dry-run']);
    return parseWorktreePruneDryRun(result.stdout + result.stderr);
  }

  async pruneWorktrees(): Promise<void> {
    await this.runGit(['worktree', 'prune']);
  }

  async getWorktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
    const statusResult = await this.runGitAt(worktreePath, ['status', '--porcelain=v1', '--branch']);
    const lines = statusResult.stdout.split('\n');
    const branchLine = lines[0] ?? '';
    const isDirty = lines.slice(1).some((l) => l.trim().length > 0);
    const { ahead, behind } = parseTrack(branchLine);
    return { isDirty, ahead, behind };
  }

  async getSubmodules(): Promise<SubmoduleEntry[]> {
    return this.submoduleSvc.getSubmodules();
  }

  async initSubmodule(submodulePath: string): Promise<void> {
    return this.submoduleSvc.initSubmodule(submodulePath);
  }

  async initAllSubmodules(): Promise<void> {
    return this.submoduleSvc.initAllSubmodules();
  }

  async updateSubmodule(submodulePath: string, recursive = false): Promise<void> {
    return this.submoduleSvc.updateSubmodule(submodulePath, recursive);
  }

  async updateAllSubmodules(recursive = false): Promise<void> {
    return this.submoduleSvc.updateAllSubmodules(recursive);
  }

  async syncSubmodule(submodulePath?: string, recursive = false): Promise<void> {
    return this.submoduleSvc.syncSubmodule(submodulePath, recursive);
  }

  async deinitSubmodule(submodulePath: string, force = false): Promise<void> {
    return this.submoduleSvc.deinitSubmodule(submodulePath, force);
  }

  async checkoutRecordedSubmoduleCommit(submodulePath: string): Promise<void> {
    return this.submoduleSvc.checkoutRecordedSubmoduleCommit(submodulePath);
  }

  async pullSubmoduleTrackedBranch(submodulePath: string): Promise<void> {
    return this.submoduleSvc.pullSubmoduleTrackedBranch(submodulePath);
  }

  async getSubmodulePointerDiff(submodulePath: string): Promise<string> {
    return this.submoduleSvc.getSubmodulePointerDiff(submodulePath);
  }

  async stageSubmodulePointer(submodulePath: string): Promise<void> {
    return this.submoduleSvc.stageSubmodulePointer(submodulePath);
  }

  private logGitDuration(command: string, startedAt: number): void {
    const shouldLog = getConfigValue<boolean>('performance.logGitCommands', false);
    const durationMs = Date.now() - startedAt;
    if (shouldLog && durationMs >= 500) {
      this.logger.info(`[perf] git command took ${durationMs}ms: ${command}`);
    }
  }

  private async runGitAt(cwd: string, args: string[]): Promise<GitCommandResult> {
    const gitPath = getConfigValue<string>('gitPath', 'git');
    const timeoutMs = getConfigValue<number>('commandTimeoutMs', 15000);

    return this.gitCommandQueue.run(() => new Promise<GitCommandResult>((resolve, reject) => {
      const command = `${gitPath} ${args.join(' ')}`;
      const startedAt = Date.now();
      const child = cp.spawn(gitPath, args, { cwd, windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        this.logGitDuration(command, startedAt);
        reject(new Error(`Git command timed out: git ${args.join(' ')}`));
      }, timeoutMs);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        this.logGitDuration(command, startedAt);
        reject(error);
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        this.logGitDuration(command, startedAt);
        if (code === 0) { resolve({ stdout, stderr }); return; }
        reject(new Error(stderr || `Git command failed with exit code ${code}`));
      });
    }));
  }

  async runGit(args: string[]): Promise<GitCommandResult> {
    const gitPath = getConfigValue<string>('gitPath', 'git');
    const timeoutMs = getConfigValue<number>('commandTimeoutMs', 15000);
    const command = `${gitPath} ${args.join(' ')}`;
    this.logger.info(`git ${args.join(' ')}`);

    return this.gitCommandQueue.run(() => new Promise<GitCommandResult>((resolve, reject) => {
      const startedAt = Date.now();
      const child = cp.spawn(gitPath, args, {
        cwd: this.gitRoot,
        windowsHide: true
      });

      const timer = setTimeout(() => {
        child.kill();
        this.logGitDuration(command, startedAt);
        reject(new Error(`Git command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        this.logGitDuration(command, startedAt);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.logGitDuration(command, startedAt);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const error = new Error(stderr || `Git command failed with exit code ${code}: ${command}`);
        reject(error);
      });
    }));
  }

  private async applyCommitFilesPatch(ref: string, filePaths: string[], reverse: boolean): Promise<void> {
    if (filePaths.length === 0) {
      return;
    }

    const patch = await this.getPatchForCommitFiles(ref, filePaths);
    if (!patch.trim()) {
      return;
    }

    if (reverse) {
      await this.runGitWithStdin(['apply', '--3way', '--whitespace=nowarn', '-R'], patch);
      return;
    }
    await this.applyPatchToWorkingTree(patch);
  }

  private async runGitWithStdin(args: string[], stdin: string): Promise<GitCommandResult> {
    const gitPath = getConfigValue<string>('gitPath', 'git');
    const timeoutMs = getConfigValue<number>('commandTimeoutMs', 15000);
    const command = `${gitPath} ${args.join(' ')}`;
    this.logger.info(`git ${args.join(' ')}`);

    return this.gitCommandQueue.run(() => new Promise<GitCommandResult>((resolve, reject) => {
      const startedAt = Date.now();
      const child = cp.spawn(gitPath, args, {
        cwd: this.gitRoot,
        windowsHide: true
      });

      const timer = setTimeout(() => {
        child.kill();
        this.logGitDuration(command, startedAt);
        reject(new Error(`Git command timed out after ${timeoutMs}ms: ${command}`));
      }, timeoutMs);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        this.logGitDuration(command, startedAt);
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        this.logGitDuration(command, startedAt);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const error = new Error(stderr || `Git command failed with exit code ${code}: ${command}`);
        reject(error);
      });

      child.stdin.end(stdin);
    }));
  }
}

function parseGraphRows(raw: string): GraphCommit[] {
  return raw
    .split(RECORD_SEPARATOR)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [graph, sha, shortSha, parentsRaw, refsRaw, author, date, subject] = line.split(FIELD_SEPARATOR);
      return {
        graph,
        sha,
        shortSha,
        parents: parentsRaw?.split(' ').filter(Boolean) ?? [],
        refs: refsRaw ? refsRaw.split(',').map((r) => r.trim()).filter(Boolean) : [],
        author,
        date,
        subject
      };
    });
}

function parseShortStat(raw: string): { files: number; insertions: number; deletions: number } | undefined {
  const line = raw
    .split('\n')
    .map((value) => value.trim())
    .find((value) => value.length > 0);

  if (!line) {
    return undefined;
  }

  const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
  const insertionsMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
  const deletionsMatch = line.match(/(\d+)\s+deletions?\(-\)/);

  return {
    files: Number(filesMatch?.[1] ?? 0),
    insertions: Number(insertionsMatch?.[1] ?? 0),
    deletions: Number(deletionsMatch?.[1] ?? 0)
  };
}
