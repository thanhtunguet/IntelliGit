import { WorktreePruneEntry } from '../types';

export interface RawWorktreeEntry {
  worktreePath: string;
  headSha: string;
  branch: string | undefined;
  isBare: boolean;
  isDetached: boolean;
  isCurrent: boolean;
  isLocked: boolean;
  lockReason: string | undefined;
  isPrunable: boolean;
  isDirty: boolean;
  ahead: number;
  behind: number;
  headSubject: string | undefined;
}

export function parseWorktreeListPorcelain(raw: string): RawWorktreeEntry[] {
  const entries: RawWorktreeEntry[] = [];
  const blocks = raw.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const entry: Partial<RawWorktreeEntry> = {
      isBare: false,
      isDetached: false,
      isCurrent: false,
      isLocked: false,
      isPrunable: false,
      isDirty: false,
      ahead: 0,
      behind: 0,
      headSubject: undefined,
      lockReason: undefined,
      branch: undefined,
      headSha: ''
    };
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        entry.worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        entry.headSha = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        const fullBranch = line.slice('branch '.length);
        entry.branch = fullBranch.replace(/^refs\/heads\//, '');
      } else if (line === 'bare') {
        entry.isBare = true;
      } else if (line === 'detached') {
        entry.isDetached = true;
      } else if (line.startsWith('locked')) {
        entry.isLocked = true;
        const reason = line.slice('locked'.length).trim();
        entry.lockReason = reason || undefined;
      } else if (line.startsWith('prunable')) {
        entry.isPrunable = true;
      }
    }
    if (entry.worktreePath) {
      entries.push(entry as RawWorktreeEntry);
    }
  }
  return entries;
}

export function parseWorktreePruneDryRun(raw: string): WorktreePruneEntry[] {
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^Removing worktrees\/(.+?):/);
      if (match) {
        return { worktreePath: match[1], reason: line };
      }
      return { worktreePath: line, reason: line };
    });
}
