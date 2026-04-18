import * as cp from 'child_process';
import * as vscode from 'vscode';
import { Logger } from '../logger';
import {
  BranchRef,
  CommitDetails,
  CompareResult,
  CommitFileChange,
  GitCommandResult,
  GraphCommit,
  MergeConflictFile,
  RepositoryContext,
  StashEntry
} from '../types';

const FIELD_SEPARATOR = '|~|';
const RECORD_SEPARATOR = '|#|';

export class GitService {
  constructor(
    private readonly context: RepositoryContext,
    private readonly logger: Logger,
    private readonly config: vscode.WorkspaceConfiguration
  ) {}

  get rootPath(): string {
    return this.context.rootPath;
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
      '%(HEAD)'
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
        const [name, fullName, upstream, track, head] = line.split(FIELD_SEPARATOR);
        const { ahead, behind } = parseTrack(track || '');
        const type: 'local' | 'remote' = fullName.startsWith('refs/remotes/') ? 'remote' : 'local';
        return {
          name,
          fullName,
          type,
          upstream: upstream || undefined,
          ahead,
          behind,
          current: head === '*'
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

  async cherryPick(ref: string): Promise<void> {
    await this.runGit(['cherry-pick', ref]);
  }

  async cherryPickRange(fromExclusive: string, toInclusive: string): Promise<void> {
    await this.runGit(['cherry-pick', `${fromExclusive}..${toInclusive}`]);
  }

  async revertCommit(ref: string): Promise<void> {
    await this.runGit(['revert', ref]);
  }

  async resetCurrent(ref: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    await this.runGit(['reset', `--${mode}`, ref]);
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

  async getChangedFiles(): Promise<Array<{ status: string; path: string }>> {
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
      const absolutePath = vscode.Uri.joinPath(this.context.rootUri, relativePath).fsPath;
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absolutePath));
      return Buffer.from(bytes).toString('utf8');
    }

    if (refSpec === 'INDEX') {
      const result = await this.runGit(['show', `:${relativePath}`]);
      return result.stdout;
    }

    const result = await this.runGit(['show', `${refSpec}:${relativePath}`]);
    return result.stdout;
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

  async getHeadCommitMessage(): Promise<string> {
    const result = await this.runGit(['log', '-1', '--pretty=%B']);
    return result.stdout.trim();
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

  async openMergeEditor(path: string): Promise<void> {
    const targetUri = vscode.Uri.file(`${this.context.rootPath}/${path}`);
    await vscode.commands.executeCommand('vscode.openWith', targetUri, 'mergeEditor');
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
        cwd: this.context.rootPath,
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
