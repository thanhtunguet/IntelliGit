import { BranchRef, CommitFilters, GraphCommit } from '../types';
import { formatCommitDate } from './commitDate';

export interface SerializedCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly author: string;
  readonly date: string;
  readonly dateLabel: string;
  readonly dateTitle: string;
  readonly dateTimestamp: number;
  readonly refs: readonly string[];
  readonly graph?: string;
}

export function sanitizeCommitFilters(filters: CommitFilters): CommitFilters {
  const trim = (value: string | undefined): string | undefined => {
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };
  return {
    branch: trim(filters.branch),
    author: trim(filters.author),
    message: trim(filters.message),
    since: trim(filters.since),
    until: trim(filters.until)
  };
}

export function collectBranchNames(branches: readonly BranchRef[]): string[] {
  return Array.from(new Set(branches.map((branch) => branch.name))).sort();
}

export function serializeCommits(commits: readonly GraphCommit[]): SerializedCommit[] {
  return commits.map((commit) => {
    const date = formatCommitDate(commit.date);
    return {
      sha: commit.sha,
      shortSha: commit.shortSha,
      subject: commit.subject,
      author: commit.author,
      date: commit.date,
      dateLabel: date.label,
      dateTitle: date.title,
      dateTimestamp: date.timestamp,
      refs: commit.refs,
      graph: commit.graph
    };
  });
}
