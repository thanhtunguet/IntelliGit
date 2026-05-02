import * as cp from 'child_process';
import * as vscode from 'vscode';
import {
  SubmoduleConfigEntry,
  SubmoduleEntry,
  SubmoduleStatusEntry,
  GitCommandResult
} from '../types';

export class SubmoduleService {
  constructor(
    private readonly config: vscode.WorkspaceConfiguration,
    private readonly gitRoot: string,
    private readonly runGit: (args: string[]) => Promise<GitCommandResult>
  ) {}

  async getSubmodules(): Promise<SubmoduleEntry[]> {
    const [statusEntries, configEntries] = await Promise.all([
      this.getSubmoduleStatus(true),
      this.getSubmoduleConfig()
    ]);

    return statusEntries.map((s) => {
      const cfg = configEntries.find((c) => c.path === s.path);
      return {
        path: s.path,
        name: cfg?.name ?? s.path,
        url: cfg?.url ?? '',
        branch: cfg?.branch,
        currentSha: s.sha,
        recordedSha: undefined,
        isInitialized: !s.isUninitialized,
        isDirty: s.isDirty,
        isPointerMismatch: s.isPointerMismatch,
        ahead: 0,
        behind: 0,
        submodules: []
      } as SubmoduleEntry;
    });
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
    const args = ['submodule', 'update', '--init', '--', submodulePath];
    if (recursive) { args.push('--recursive'); }
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
    const gitPath = this.config.get<string>('gitPath', 'git');
    const timeoutMs = this.config.get<number>('commandTimeoutMs', 15000);
    const fullCwd = cwd.startsWith('/') ? cwd : `${this.gitRoot}/${cwd}`;

    return new Promise<GitCommandResult>((resolve, reject) => {
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
    });
  }
}

interface MutableSubmoduleConfigEntry {
  name: string;
  path?: string;
  url?: string;
  branch?: string;
}

export function parseSubmoduleConfig(raw: string): SubmoduleConfigEntry[] {
  const map = new Map<string, MutableSubmoduleConfigEntry>();

  for (const line of raw.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const match = line.match(/^submodule\.(.+?)\.(path|url|branch)\s+(.+)$/);
    if (!match) { continue; }
    const [, name, key, value] = match;
    if (!map.has(name)) { map.set(name, { name }); }
    const entry = map.get(name)!;
    if (key === 'path') { entry.path = value; }
    else if (key === 'url') { entry.url = value; }
    else if (key === 'branch') { entry.branch = value; }
  }

  return Array.from(map.values())
    .filter((e): e is SubmoduleConfigEntry => Boolean(e.path && e.url))
    .map((e) => ({
      name: e.name,
      path: e.path!,
      url: e.url!,
      branch: e.branch
    }));
}

export function parseSubmoduleStatus(raw: string): SubmoduleStatusEntry[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const prefix = line[0];
      const rest = line.slice(1).trim();
      const spaceIdx = rest.indexOf(' ');
      const sha = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
      const pathAndDesc = spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1);
      const parenIdx = pathAndDesc.indexOf('(');
      const subPath = (parenIdx === -1 ? pathAndDesc : pathAndDesc.slice(0, parenIdx)).trim();

      return {
        path: subPath,
        sha,
        isUninitialized: prefix === '-',
        isDirty: prefix === '+',
        isPointerMismatch: prefix === '+',
        isNested: subPath.includes('/')
      } as SubmoduleStatusEntry;
    });
}
