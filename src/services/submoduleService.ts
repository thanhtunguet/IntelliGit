import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfigValue } from '../configuration';
import {
  SubmoduleConfigEntry,
  SubmoduleEntry,
  SubmoduleStatusEntry,
  GitCommandResult
} from '../types';
import { GitCommandQueue } from './gitCommandQueue';
import { parseSubmoduleConfig, parseSubmoduleStatus } from './submoduleParsing';
import { SubmoduleLogSink, NULL_SINK } from './submoduleLogSink';

export interface SpawnGitStreamingOptions {
  gitRoot: string;
  cwd?: string;          // resolved via resolveSubmoduleCwd when provided
  sink: SubmoduleLogSink;
  signal?: AbortSignal;
}

export interface SpawnGitStreamingResult {
  exitCode: number | null;
}

/**
 * Spawn a git invocation with no timeout, line-buffered stdout/stderr
 * forwarded through the sink, and AbortSignal-based cancellation.
 *
 * - Never rejects on non-zero exit; caller checks exitCode.
 * - The exec name (`gitPath`) is passed explicitly so tests can substitute `node -e ...`.
 * - sink.header is NOT called by this helper — the caller writes the header so it can
 *   show the user a human-readable command line (with `--`, paths, etc.).
 */
export function spawnGitStreaming(
  execPath: string,
  args: string[],
  options: SpawnGitStreamingOptions
): Promise<SpawnGitStreamingResult> {
  const { gitRoot, cwd, sink, signal } = options;
  const fullCwd = cwd ? resolveSubmoduleCwd(gitRoot, cwd) : gitRoot;
  const startedAt = Date.now();

  return new Promise<SpawnGitStreamingResult>((resolve) => {
    let settled = false;
    const settle = (exitCode: number | null) => {
      if (settled) { return; }
      settled = true;
      sink.done(exitCode, Date.now() - startedAt);
      resolve({ exitCode });
    };

    let child: cp.ChildProcessWithoutNullStreams;
    try {
      child = cp.spawn(execPath, args, { cwd: fullCwd, windowsHide: true });
    } catch (err) {
      sink.error(err instanceof Error ? err : new Error(String(err)));
      settle(null);
      return;
    }

    const stdoutBuf = makeLineBuffer((line) => sink.stdout(line));
    const stderrBuf = makeLineBuffer((line) => sink.stderr(line));

    child.stdout.on('data', (chunk: Buffer) => stdoutBuf.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => stderrBuf.push(chunk.toString()));
    child.on('error', (err: Error) => {
      sink.error(err);
      settle(null);
    });
    child.on('close', (code: number | null) => {
      stdoutBuf.flush();
      stderrBuf.flush();
      settle(code);
    });

    if (signal) {
      const abort = () => { try { child.kill(); } catch { /* already exited */ } };
      if (signal.aborted) { abort(); }
      else { signal.addEventListener('abort', abort, { once: true }); }
    }
  });
}

/**
 * Splits a stream of incoming string chunks into newline-delimited lines,
 * forwarding each completed line via `onLine`. Carriage-return-only progress
 * redraws inside a single line segment are collapsed to the last segment.
 */
function makeLineBuffer(onLine: (line: string) => void) {
  let pending = '';
  const emit = (segment: string) => {
    // segment ends at \n, so collapse \r-only redraws inside it.
    const parts = segment.split('\r');
    const last = parts[parts.length - 1];
    if (last.length > 0) { onLine(last); }
  };
  return {
    push(chunk: string) {
      pending += chunk;
      let idx = pending.indexOf('\n');
      while (idx !== -1) {
        emit(pending.slice(0, idx));
        pending = pending.slice(idx + 1);
        idx = pending.indexOf('\n');
      }
    },
    flush() {
      if (pending.length > 0) {
        emit(pending);
        pending = '';
      }
    }
  };
}

export class SubmoduleService {
  private readonly gitCommandQueue = new GitCommandQueue(process.platform === 'win32' ? 2 : 4);

  constructor(
    private readonly config: vscode.WorkspaceConfiguration,
    private readonly gitRoot: string,
    private readonly runGit: (args: string[]) => Promise<GitCommandResult>
  ) {}

  private spawnGitStreaming(
    args: string[],
    options: { cwd?: string; sink?: SubmoduleLogSink; signal?: AbortSignal }
  ): Promise<SpawnGitStreamingResult> {
    const gitPath = getConfigValue<string>('gitPath', 'git');
    return spawnGitStreaming(gitPath, args, {
      gitRoot: this.gitRoot,
      cwd: options.cwd,
      sink: options.sink ?? NULL_SINK,
      signal: options.signal
    });
  }

  async getSubmodules(): Promise<SubmoduleEntry[]> {
    const [statusEntries, configEntries] = await Promise.all([
      this.getSubmoduleStatus(true),
      this.getSubmoduleConfig()
    ]);

    return Promise.all(statusEntries.map(async (s) => {
      const cfg = configEntries.find((c) => c.path === s.path);
      const recordedSha = await this.getRecordedSubmoduleSha(s.path);
      const localStatus = s.isUninitialized
        ? { isDirty: false, ahead: 0, behind: 0 }
        : await this.getSubmoduleWorktreeStatus(s.path);
      const currentSha = s.isUninitialized ? undefined : s.sha;
      const isPointerMismatch = s.isPointerMismatch || Boolean(currentSha && recordedSha && currentSha !== recordedSha);
      return {
        path: s.path,
        name: cfg?.name ?? s.path,
        url: cfg?.url ?? '',
        branch: cfg?.branch,
        currentSha,
        recordedSha: recordedSha ?? (s.isUninitialized ? s.sha : undefined),
        isInitialized: !s.isUninitialized,
        isDirty: s.isDirty || localStatus.isDirty,
        isPointerMismatch,
        ahead: localStatus.ahead,
        behind: localStatus.behind,
        submodules: []
      } as SubmoduleEntry;
    }));
  }

  async getSubmoduleConfig(): Promise<SubmoduleConfigEntry[]> {
    let raw: string;
    try {
      const result = await this.runGit(['config', '--file', '.gitmodules', '--get-regexp', '.*']);
      raw = result.stdout;
    } catch {
      return [];
    }

    return parseSubmoduleConfig(raw);
  }

  async getSubmoduleStatus(recursive = false): Promise<SubmoduleStatusEntry[]> {
    try {
      const args = ['submodule', 'status'];
      if (recursive) { args.push('--recursive'); }
      const result = await this.runGit(args);
      return parseSubmoduleStatus(result.stdout);
    } catch {
      return [];
    }
  }

  async initSubmodule(submodulePath: string): Promise<void> {
    await this.runGit(['submodule', 'init', '--', submodulePath]);
  }

  async initAllSubmodules(): Promise<void> {
    await this.runGit(['submodule', 'init']);
  }

  async updateSubmodule(submodulePath: string, recursive = false): Promise<void> {
    const args = ['submodule', 'update', '--init'];
    if (recursive) { args.push('--recursive'); }
    args.push('--', submodulePath);
    await this.runGit(args);
  }

  async updateAllSubmodules(recursive = false): Promise<void> {
    const args = ['submodule', 'update', '--init'];
    if (recursive) { args.push('--recursive'); }
    await this.runGit(args);
  }

  async syncSubmodule(submodulePath?: string, recursive = false): Promise<void> {
    const args = ['submodule', 'sync'];
    if (recursive) { args.push('--recursive'); }
    if (submodulePath) { args.push('--', submodulePath); }
    await this.runGit(args);
  }

  async deinitSubmodule(submodulePath: string, force = false): Promise<void> {
    const args = ['submodule', 'deinit'];
    if (force) { args.push('-f'); }
    args.push('--', submodulePath);
    await this.runGit(args);
  }

  async checkoutRecordedSubmoduleCommit(submodulePath: string): Promise<void> {
    await this.runGit(['submodule', 'update', '--', submodulePath]);
  }

  async pullSubmoduleTrackedBranch(submodulePath: string): Promise<void> {
    await this.runGitAt(submodulePath, ['pull']);
  }

  async getSubmodulePointerDiff(submodulePath: string): Promise<string> {
    const result = await this.runGit(['diff', '--submodule=log', '--', submodulePath]);
    return result.stdout;
  }

  async stageSubmodulePointer(submodulePath: string): Promise<void> {
    await this.runGit(['add', '--', submodulePath]);
  }

  private async runGitAt(cwd: string, args: string[]): Promise<GitCommandResult> {
    const gitPath = getConfigValue<string>('gitPath', 'git');
    const timeoutMs = getConfigValue<number>('commandTimeoutMs', 15000);
    const fullCwd = resolveSubmoduleCwd(this.gitRoot, cwd);

    return this.gitCommandQueue.run(() => new Promise<GitCommandResult>((resolve, reject) => {
      const child = cp.spawn(gitPath, args, { cwd: fullCwd, windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`Git command timed out: git ${args.join(' ')}`));
      }, timeoutMs);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', (error: Error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) { resolve({ stdout, stderr }); return; }
        reject(new Error(stderr || `Git command failed with exit code ${code}`));
      });
    }));
  }

  private async getSubmoduleWorktreeStatus(
    submodulePath: string
  ): Promise<{ isDirty: boolean; ahead: number; behind: number }> {
    try {
      const result = await this.runGitAt(submodulePath, ['status', '--porcelain=v1', '--branch']);
      const lines = result.stdout.split(/\r?\n/);
      const branchLine = lines[0] ?? '';
      const isDirty = lines.slice(1).some((line) => line.trim().length > 0);
      const { ahead, behind } = parseTrack(branchLine);
      return { isDirty, ahead, behind };
    } catch {
      return { isDirty: false, ahead: 0, behind: 0 };
    }
  }

  private async getRecordedSubmoduleSha(submodulePath: string): Promise<string | undefined> {
    try {
      const result = await this.runGit(['ls-files', '-s', '--', submodulePath]);
      const line = result.stdout.split(/\r?\n/).find((value) => value.trim().length > 0);
      if (!line) { return undefined; }
      const match = line.match(/^\d+\s+([0-9a-fA-F]{7,40})\s+\d+\t/);
      return match?.[1];
    } catch {
      return undefined;
    }
  }
}

export function resolveSubmoduleCwd(gitRoot: string, cwd: string): string {
  return path.isAbsolute(cwd) ? cwd : path.join(gitRoot, cwd);
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
