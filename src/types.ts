import * as vscode from 'vscode';

export type BranchType = 'local' | 'remote';

export interface BranchRef {
  readonly name: string;
  readonly fullName: string;
  readonly type: BranchType;
  readonly upstream?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly current: boolean;
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

export interface ComparePair {
  readonly left: string;
  readonly right: string;
}

export interface CommitFileChange {
  readonly status: string;
  readonly path: string;
}
