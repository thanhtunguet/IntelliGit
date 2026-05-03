import * as vscode from 'vscode';

export type BranchType = 'local' | 'remote';

export interface CommitFilters {
  readonly branch?: string;
  readonly author?: string;
  readonly message?: string;
  readonly since?: string;
  readonly until?: string;
}

export interface RefComparison {
  readonly ref: string;
  readonly ahead: number;
  readonly behind: number;
}

export interface BranchRef {
  readonly name: string;
  readonly shortName: string;
  readonly fullName: string;
  readonly type: BranchType;
  readonly remoteName?: string;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly current: boolean;
  readonly lastCommitEpoch?: number;
  readonly comparison?: RefComparison;
}

export interface TagRef {
  readonly name: string;
  readonly fullName: string;
  readonly sha?: string;
  readonly lastCommitEpoch?: number;
  readonly comparison?: RefComparison;
}

export interface StashEntry {
  readonly index: number;
  readonly ref: string;
  readonly message: string;
  readonly author?: string;
  readonly timestamp?: string;
  readonly fileCount: number;
  readonly sha?: string;
}

export interface GraphCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly graph?: string;
  readonly parents: string[];
  readonly refs: string[];
  readonly author: string;
  readonly date: string;
  readonly subject: string;
  readonly stats?: {
    readonly files: number;
    readonly insertions: number;
    readonly deletions: number;
  };
}

export interface CompareResult {
  readonly leftRef: string;
  readonly rightRef: string;
  readonly commitsOnlyLeft: GraphCommit[];
  readonly commitsOnlyRight: GraphCommit[];
  readonly changedFiles: Array<{
    readonly path: string;
    readonly status: string;
  }>;
}

export interface CommitDetails {
  readonly commit: GraphCommit;
  readonly body: string;
  readonly changedFiles: Array<{
    readonly status: string;
    readonly path: string;
  }>;
}

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

export interface QuickAction {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface Refreshable {
  refresh(): Promise<void>;
}

export interface RepositoryContext {
  readonly rootUri: vscode.Uri;
  readonly rootPath: string;
}

export interface MergeConflictFile {
  readonly path: string;
  readonly status: string;
}

export type GitOperationKind = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'none';

export interface GitOperationState {
  readonly kind: GitOperationKind;
  readonly headShort?: string;
  readonly ontoShort?: string;
  readonly message?: string;
  readonly stepCurrent?: number;
  readonly stepTotal?: number;
}

export interface ComparePair {
  readonly left: string;
  readonly right: string;
}

export interface CommitFileChange {
  readonly status: string;
  readonly path: string;
}

export interface WorkingTreeChange {
  readonly status: string;
  readonly path: string;
}

// ── Worktree types ────────────────────────────────────────────────────────────

export interface WorktreeEntry {
  readonly worktreePath: string;
  readonly headSha: string;
  readonly branch: string | undefined;
  readonly isBare: boolean;
  readonly isDetached: boolean;
  readonly isCurrent: boolean;
  readonly isLocked: boolean;
  readonly lockReason: string | undefined;
  readonly isPrunable: boolean;
  readonly isDirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly headSubject: string | undefined;
}

export interface WorktreeStatus {
  readonly isDirty: boolean;
  readonly ahead: number;
  readonly behind: number;
}

export interface WorktreePruneEntry {
  readonly worktreePath: string;
  readonly reason: string;
}

// ── Submodule types ───────────────────────────────────────────────────────────

export interface SubmoduleEntry {
  readonly path: string;
  readonly name: string;
  readonly url: string;
  readonly branch: string | undefined;
  readonly currentSha: string | undefined;
  readonly recordedSha: string | undefined;
  readonly isInitialized: boolean;
  readonly isDirty: boolean;
  readonly isPointerMismatch: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly submodules: SubmoduleEntry[];
}

export interface SubmoduleConfigEntry {
  readonly name: string;
  readonly path: string;
  readonly url: string;
  readonly branch: string | undefined;
}

export interface SubmoduleStatusEntry {
  readonly path: string;
  readonly sha: string;
  readonly isUninitialized: boolean;
  readonly isDirty: boolean;
  readonly isPointerMismatch: boolean;
  readonly isNested: boolean;
}
