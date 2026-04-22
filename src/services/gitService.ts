import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from '../logger';
import {
  BranchRef,
  CommitDetails,
  CommitFileChange,
  CompareResult,
  GitCommandResult,
  GitOperationState,
  GraphCommit,
  MergeConflictFile,
  RepositoryContext,
  StashEntry,
  WorkingTreeChange
} from '../types';

const FIELD_SEPARATOR = '|~|';
const RECORD_SEPARATOR = '|#|';

export class GitService {
  private _gitRootCache: string | undefined;

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
    try {
      const result = await this.runGit(['rev-parse', '--is-inside-work-tree']);
      return result.stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async getCurrentBranch(): Promise<string> {
    const result = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    return result.stdout.trim();
  }

  async getCurrentHeadSha(): Promise<string> {
    const result = await this.runGit(['rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  async getBranches(): Promise<BranchRef[]> {
    const format = [
      '%(refname:short)',
      '%(refname)',
      '%(upstream:short)',
      '%(upstream:track)',
      '%(HEAD)',
      '%(committerdate:unix)'
    ].join(FIELD_SEPARATOR);

    const result = await this.runGit([
      'for-each-ref',
      `--format=${format}${RECORD_SEPARATOR}`,
      'refs/heads',
      'refs/remotes'
    ]);

    return result.stdout
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
          upstream: upstream || undefined,
          ahead,
          behind,
          current: head === '*',
          lastCommitEpoch: Number.isNaN(commitEpoch) ? undefined : commitEpoch
        };
      })
      .sort((a, b) => {
        if (a.current) {
          return -1;
        }
        if (b.current) {
          return 1;
        }
        if (a.type !== b.type) {
          return a.type === 'local' ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });
  }

  async createBranch(name: string, base?: string): Promise<void> {
    const args = ['branch', name];
    if (base) {
      args.push(base);
    }
    await this.runGit(args);
  }

  async createTag(name: string, ref: string): Promise<void> {
    await this.runGit(['tag', name, ref]);
  }

  async renameBranch(from: string, to: string): Promise<void> {
    await this.runGit(['branch', '-m', from, to]);
  }

  async deleteBranch(branch: string, force = false): Promise<void> {
    await this.runGit(['branch', force ? '-D' : '-d', branch]);
  }

  async checkoutBranch(branch: string): Promise<void> {
    await this.runGit(['checkout', branch]);
  }

  async checkoutCommit(commit: string): Promise<void> {
    await this.runGit(['checkout', commit]);
  }

  async trackBranch(localBranch: string, upstream: string): Promise<void> {
    await this.runGit(['branch', '--set-upstream-to', upstream, localBranch]);
  }

  async untrackBranch(localBranch: string): Promise<void> {
    await this.runGit(['branch', '--unset-upstream', localBranch]);
  }

  async hasUpstream(localBranch: string): Promise<boolean> {
    try {
      await this.runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${localBranch}@{upstream}`]);
      return true;
    } catch {
      return false;
    }
  }

  async mergeIntoCurrent(branch: string): Promise<void> {
    await this.runGit(['merge', '--no-ff', branch]);
  }

  async rebaseCurrentOnto(branch: string): Promise<void> {
    await this.runGit(['rebase', branch]);
  }

  async rebaseInteractive(base: string): Promise<void> {
    await this.runGit(['rebase', '-i', base]);
  }

  async mergeAbort(): Promise<void> {
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

    // Rebase: interactive/merge backend
    if (await exists('rebase-merge')) {
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
    if (await exists('rebase-apply')) {
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

    if (await exists('MERGE_HEAD')) {
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

    if (await exists('CHERRY_PICK_HEAD')) {
      const head = await readFile('CHERRY_PICK_HEAD');
      return { kind: 'cherry-pick', headShort: await shortenRef(head) };
    }

    if (await exists('REVERT_HEAD')) {
      const head = await readFile('REVERT_HEAD');
      return { kind: 'revert', headShort: await shortenRef(head) };
    }

    return { kind: 'none' };
  }

  private _gitDirCache: string | undefined;
  private async getGitDir(): Promise<string | undefined> {
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

  async cherryPickCommitFiles(ref: string, filePaths: string[], subject?: string): Promise<void> {
    await this.applyCommitFilesPatch(ref, filePaths, false);
    const staged = await this.getStagedFiles();
    if (staged.length === 0) {
      return;
    }

    const title = subject?.trim() || ref.slice(0, 8);
    const message = `Cherry-pick selected changes from ${ref.slice(0, 8)} ${title}`.trim();
    await this.runGit(['commit', '-m', message]);
  }

  async cherryPickRange(fromExclusive: string, toInclusive: string): Promise<void> {
    await this.runGit(['cherry-pick', `${fromExclusive}..${toInclusive}`]);
  }

  async revertCommit(ref: string): Promise<void> {
    await this.runGit(['revert', ref]);
  }

  async revertCommitFiles(ref: string, filePaths: string[], subject?: string): Promise<void> {
    await this.applyCommitFilesPatch(ref, filePaths, true);
    const staged = await this.getStagedFiles();
    if (staged.length === 0) {
      return;
    }

    const title = subject?.trim() || ref.slice(0, 8);
    const message = `Revert selected changes from ${ref.slice(0, 8)} ${title}`.trim();
    await this.runGit(['commit', '-m', message]);
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

  async getRevision(ref: string): Promise<string> {
    const result = await this.runGit(['rev-parse', ref]);
    return result.stdout.trim();
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
      const fileCount = await this.getStashFileCount(ref);
      entries.push({
        index,
        ref,
        message: message || subject,
        author: author || undefined,
        timestamp: timestamp || undefined,
        fileCount,
        sha: sha || undefined
      });
    }

    return entries.sort((a, b) => a.index - b.index);
  }

  async createStash(message: string, options: { includeUntracked: boolean; keepIndex: boolean }): Promise<void> {
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

  async getGraph(maxCount: number, filters?: {
    branch?: string;
    author?: string;
    message?: string;
    since?: string;
    until?: string;
  }): Promise<GraphCommit[]> {
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

  async getRevisionForFile(filePath: string, refSpec: string): Promise<string | undefined> {
    const result = await this.runGit(['ls-tree', '-r', refSpec, '--', filePath]);
    const row = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);

    if (!row) {
      return undefined;
    }

    const split = row.split(/\s+/);
    return split.length >= 3 ? split[2] : undefined;
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

    return {
      leftRef,
      rightRef,
      commitsOnlyLeft: parseGraphRows(leftOnly.stdout),
      commitsOnlyRight: parseGraphRows(rightOnly.stdout),
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

  async getChangedFiles(): Promise<WorkingTreeChange[]> {
    const result = await this.runGit(['status', '--porcelain']);
    return result.stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter(Boolean)
      .map((line) => ({
        status: line.slice(0, 2),
        path: line.slice(3)
      }));
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

  async openDiffRange(leftSpec: string, rightSpec: string, relativePath: string): Promise<{ leftContent: string; rightContent: string }> {
    const left = await this.getFileContentFromRef(leftSpec, relativePath);
    const right = await this.getFileContentFromRef(rightSpec, relativePath);
    return {
      leftContent: left,
      rightContent: right
    };
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

  async stageFile(path: string): Promise<void> {
    await this.runGit(['add', '--', path]);
  }

  async unstageFile(path: string): Promise<void> {
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
    await this.runGit(['push']);
  }

  async pull(): Promise<void> {
    await this.runGit(['pull']);
  }

  async fetchPrune(): Promise<void> {
    await this.runGit(['fetch', '--prune']);
  }

  async addAll(): Promise<void> {
    await this.runGit(['add', '-A']);
  }

  async stagePatch(filePath: string): Promise<void> {
    await this.runGit(['add', '-p', '--', filePath]);
  }

  async amendCommit(message?: string): Promise<void> {
    const args = ['commit', '--amend'];
    if (message) {
      args.push('-m', message);
    } else {
      args.push('--no-edit');
    }
    await this.runGit(args);
  }

  async commit(message: string): Promise<void> {
    await this.runGit(['commit', '-m', message]);
  }

  async commitOnly(message: string, paths: readonly string[]): Promise<void> {
    if (paths.length === 0) {
      throw new Error('No paths provided for changelist commit.');
    }
    // `git commit --only` commits only the given paths without touching previously staged
    // changes on other files, and it stages untracked paths automatically.
    await this.runGit(['commit', '--only', '-m', message, '--', ...paths]);
  }

  async getHeadCommitMessage(): Promise<string> {
    const result = await this.runGit(['log', '-1', '--pretty=%B']);
    return result.stdout.trim();
  }

  async unstageAll(): Promise<void> {
    await this.runGit(['restore', '--staged', '.']);
  }

  async discardFile(filePath: string, isUntracked: boolean): Promise<void> {
    if (isUntracked) {
      await this.runGit(['clean', '-f', '--', filePath]);
    } else {
      await this.runGit(['restore', '--', filePath]);
    }
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
        const tmpPath = path.join(tmpDir, `intelligit_${safe}_${suffix}`);
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

  private async getStashFileCount(ref: string): Promise<number> {
    try {
      const result = await this.runGit(['stash', 'show', '--name-only', ref]);
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  async runGit(args: string[]): Promise<GitCommandResult> {
    const gitPath = this.config.get<string>('gitPath', 'git');
    const timeoutMs = this.config.get<number>('commandTimeoutMs', 15000);
    const command = `${gitPath} ${args.join(' ')}`;
    this.logger.info(`git ${args.join(' ')}`);

    return new Promise<GitCommandResult>((resolve, reject) => {
      const child = cp.spawn(gitPath, args, {
        cwd: this.gitRoot,
        windowsHide: true
      });

      const timer = setTimeout(() => {
        child.kill();
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
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const error = new Error(stderr || `Git command failed with exit code ${code}: ${command}`);
        reject(error);
      });
    });
  }

  private async applyCommitFilesPatch(ref: string, filePaths: string[], reverse: boolean): Promise<void> {
    if (filePaths.length === 0) {
      return;
    }

    const patch = await this.getPatchForCommitFiles(ref, filePaths);
    if (!patch.trim()) {
      return;
    }

    const args = ['apply', '--index', '--3way', '--whitespace=nowarn'];
    if (reverse) {
      args.push('-R');
    }
    await this.runGitWithStdin(args, patch);
  }

  private async runGitWithStdin(args: string[], stdin: string): Promise<GitCommandResult> {
    const gitPath = this.config.get<string>('gitPath', 'git');
    const timeoutMs = this.config.get<number>('commandTimeoutMs', 15000);
    const command = `${gitPath} ${args.join(' ')}`;
    this.logger.info(`git ${args.join(' ')}`);

    return new Promise<GitCommandResult>((resolve, reject) => {
      const child = cp.spawn(gitPath, args, {
        cwd: this.gitRoot,
        windowsHide: true
      });

      const timer = setTimeout(() => {
        child.kill();
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
        reject(error);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }

        const error = new Error(stderr || `Git command failed with exit code ${code}: ${command}`);
        reject(error);
      });

      child.stdin.end(stdin);
    });
  }
}

function parseTrack(value: string): { ahead: number; behind: number } {
  if (!value) {
    return { ahead: 0, behind: 0 };
  }

  const aheadMatch = value.match(/ahead (\d+)/);
  const behindMatch = value.match(/behind (\d+)/);
  return {
    ahead: Number(aheadMatch?.[1] ?? 0),
    behind: Number(behindMatch?.[1] ?? 0)
  };
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
