//! Git service module - Native git CLI wrapper
//!
//! This module provides typed methods for executing git commands,
//! mirroring the functionality from the VSCode version's gitService.ts

use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;
use tokio::process::Command;
use tokio::sync::RwLock;

use crate::types::*;

const FIELD_SEPARATOR: &str = "|~|";
const RECORD_SEPARATOR: &str = "|#|";

/// Git service error types
#[derive(Error, Debug)]
pub enum GitError {
    #[error("Git command failed: {0}")]
    CommandFailed(String),
    #[error("Git not found: {0}")]
    GitNotFound(String),
    #[error("Timeout: {0}")]
    Timeout(String),
    #[error("Parse error: {0}")]
    ParseError(String),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
}

/// Result type for git operations
pub type GitResult<T> = Result<T, GitError>;

/// Git command result
#[derive(Debug, Clone)]
pub struct GitCommandResult {
    pub stdout: String,
    pub stderr: String,
}

/// Repository context
#[derive(Debug, Clone)]
pub struct RepositoryContext {
    pub root_path: PathBuf,
}

/// Git service configuration
#[derive(Debug, Clone)]
pub struct GitConfig {
    pub git_path: String,
    pub timeout_ms: u64,
}

impl Default for GitConfig {
    fn default() -> Self {
        Self {
            git_path: "git".to_string(),
            timeout_ms: 15000,
        }
    }
}

/// Git service for executing git commands
pub struct GitService {
    context: RepositoryContext,
    config: GitConfig,
    git_dir_cache: RwLock<Option<PathBuf>>,
}

impl GitService {
    /// Create a new GitService instance
    pub fn new(context: RepositoryContext, config: GitConfig) -> Self {
        Self {
            context,
            config,
            git_dir_cache: RwLock::new(None),
        }
    }

    /// Get the repository root path
    pub fn root_path(&self) -> &Path {
        &self.context.root_path
    }

    /// Check if the current directory is a git repository
    pub async fn is_repo(&self) -> bool {
        match self.run_git(&["rev-parse", "--is-inside-work-tree"]).await {
            Ok(result) => result.stdout.trim() == "true",
            Err(_) => false,
        }
    }

    /// Get the current branch name
    pub async fn get_current_branch(&self) -> GitResult<String> {
        let result = self.run_git(&["rev-parse", "--abbrev-ref", "HEAD"]).await?;
        Ok(result.stdout.trim().to_string())
    }

    /// Get the current HEAD SHA
    pub async fn get_current_head_sha(&self) -> GitResult<String> {
        let result = self.run_git(&["rev-parse", "HEAD"]).await?;
        Ok(result.stdout.trim().to_string())
    }

    /// Get all branches (local and remote)
    pub async fn get_branches(&self) -> GitResult<Vec<BranchRef>> {
        let format = [
            "%(refname:short)",
            "%(refname)",
            "%(upstream:short)",
            "%(upstream:track)",
            "%(HEAD)",
            "%(committerdate:unix)",
        ].join(FIELD_SEPARATOR);

        let format_arg = format!("--format={}{}", format, RECORD_SEPARATOR);

        let result = self.run_git(&[
            "for-each-ref",
            &format_arg,
            "refs/heads",
            "refs/remotes",
        ]).await?;

        let mut branches: Vec<BranchRef> = result.stdout
            .split(RECORD_SEPARATOR)
            .map(|line| line.trim())
            .filter(|s| !s.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.split(FIELD_SEPARATOR).collect();
                if parts.len() < 6 {
                    return None;
                }
                
                let name = parts[0].to_string();
                let full_name = parts[1].to_string();
                let upstream = if parts[2].is_empty() { None } else { Some(parts[2].to_string()) };
                let track = parts[3];
                let head = parts[4];
                let commit_epoch = parts[5].parse::<u64>().ok();

                let (ahead, behind) = parse_track(track);
                let branch_type = if full_name.starts_with("refs/remotes/") {
                    BranchType::Remote
                } else {
                    BranchType::Local
                };

                let short_name = if branch_type == BranchType::Remote {
                    let prefix = format!("{}/", name.split('/').next()?);
                    name.strip_prefix(&prefix)?
                        .to_string()
                } else {
                    name.clone()
                };

                let remote_name = if branch_type == BranchType::Remote {
                    name.split('/').next().map(|s| s.to_string())
                } else {
                    None
                };

                Some(BranchRef {
                    name,
                    short_name,
                    full_name,
                    branch_type,
                    remote_name,
                    upstream,
                    ahead,
                    behind,
                    current: head == "*",
                    last_commit_epoch: commit_epoch,
                })
            })
            .collect();

        // Sort: current first, then local before remote, then alphabetically
        branches.sort_by(|a, b| {
            if a.current {
                std::cmp::Ordering::Less
            } else if b.current {
                std::cmp::Ordering::Greater
            } else if a.branch_type != b.branch_type {
                if a.branch_type == BranchType::Local {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Greater
                }
            } else {
                a.name.cmp(&b.name)
            }
        });

        Ok(branches)
    }

    /// Create a new branch
    pub async fn create_branch(&self, name: &str, base: Option<&str>) -> GitResult<()> {
        let mut args = vec!["branch", name];
        if let Some(b) = base {
            args.push(b);
        }
        self.run_git(&args).await?;
        Ok(())
    }

    /// Create a tag
    pub async fn create_tag(&self, name: &str, ref_: &str) -> GitResult<()> {
        self.run_git(&["tag", name, ref_]).await?;
        Ok(())
    }

    /// Rename a branch
    pub async fn rename_branch(&self, from: &str, to: &str) -> GitResult<()> {
        self.run_git(&["branch", "-m", from, to]).await?;
        Ok(())
    }

    /// Delete a branch
    pub async fn delete_branch(&self, branch: &str, force: bool) -> GitResult<()> {
        let flag = if force { "-D" } else { "-d" };
        self.run_git(&["branch", flag, branch]).await?;
        Ok(())
    }

    /// Checkout a branch
    pub async fn checkout_branch(&self, branch: &str) -> GitResult<()> {
        self.run_git(&["checkout", branch]).await?;
        Ok(())
    }

    /// Checkout a commit (detached HEAD)
    pub async fn checkout_commit(&self, commit: &str) -> GitResult<()> {
        self.run_git(&["checkout", commit]).await?;
        Ok(())
    }

    /// Set upstream for a branch
    pub async fn track_branch(&self, local_branch: &str, upstream: &str) -> GitResult<()> {
        self.run_git(&["branch", "--set-upstream-to", upstream, local_branch]).await?;
        Ok(())
    }

    /// Unset upstream for a branch
    pub async fn untrack_branch(&self, local_branch: &str) -> GitResult<()> {
        self.run_git(&["branch", "--unset-upstream", local_branch]).await?;
        Ok(())
    }

    /// Check if a branch has an upstream
    pub async fn has_upstream(&self, local_branch: &str) -> bool {
        let upstream_arg = format!("{}@{{upstream}}", local_branch);
        self.run_git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", &upstream_arg])
            .await
            .is_ok()
    }

    /// Merge a branch into current
    pub async fn merge_into_current(&self, branch: &str) -> GitResult<()> {
        self.run_git(&["merge", "--no-ff", branch]).await?;
        Ok(())
    }

    /// Rebase current onto another branch
    pub async fn rebase_current_onto(&self, branch: &str) -> GitResult<()> {
        self.run_git(&["rebase", branch]).await?;
        Ok(())
    }

    /// Interactive rebase
    pub async fn rebase_interactive(&self, base: &str) -> GitResult<()> {
        self.run_git(&["rebase", "-i", base]).await?;
        Ok(())
    }

    /// Abort merge
    pub async fn merge_abort(&self) -> GitResult<()> {
        self.run_git(&["merge", "--abort"]).await?;
        Ok(())
    }

    /// Abort rebase
    pub async fn rebase_abort(&self) -> GitResult<()> {
        self.run_git(&["rebase", "--abort"]).await?;
        Ok(())
    }

    /// Continue rebase
    pub async fn rebase_continue(&self) -> GitResult<()> {
        self.run_git(&["-c", "core.editor=true", "rebase", "--continue"]).await?;
        Ok(())
    }

    /// Skip rebase commit
    pub async fn rebase_skip(&self) -> GitResult<()> {
        self.run_git(&["rebase", "--skip"]).await?;
        Ok(())
    }

    /// Abort cherry-pick
    pub async fn cherry_pick_abort(&self) -> GitResult<()> {
        self.run_git(&["cherry-pick", "--abort"]).await?;
        Ok(())
    }

    /// Continue cherry-pick
    pub async fn cherry_pick_continue(&self) -> GitResult<()> {
        self.run_git(&["-c", "core.editor=true", "cherry-pick", "--continue"]).await?;
        Ok(())
    }

    /// Skip cherry-pick
    pub async fn cherry_pick_skip(&self) -> GitResult<()> {
        self.run_git(&["cherry-pick", "--skip"]).await?;
        Ok(())
    }

    /// Abort revert
    pub async fn revert_abort(&self) -> GitResult<()> {
        self.run_git(&["revert", "--abort"]).await?;
        Ok(())
    }

    /// Continue revert
    pub async fn revert_continue(&self) -> GitResult<()> {
        self.run_git(&["-c", "core.editor=true", "revert", "--continue"]).await?;
        Ok(())
    }

    /// Resolve conflict using ours
    pub async fn resolve_conflict_ours(&self, path: &str) -> GitResult<()> {
        self.run_git(&["checkout", "--ours", "--", path]).await?;
        self.run_git(&["add", "--", path]).await?;
        Ok(())
    }

    /// Resolve conflict using theirs
    pub async fn resolve_conflict_theirs(&self, path: &str) -> GitResult<()> {
        self.run_git(&["checkout", "--theirs", "--", path]).await?;
        self.run_git(&["add", "--", path]).await?;
        Ok(())
    }

    /// Get the current git operation state (merge, rebase, etc.)
    pub async fn get_operation_state(&self) -> GitResult<GitOperationState> {
        let git_dir = self.get_git_dir().await?;
        
        if git_dir.is_none() {
            return Ok(GitOperationState {
                kind: GitOperationKind::None,
                head_short: None,
                onto_short: None,
                message: None,
                step_current: None,
                step_total: None,
            });
        }

        let git_dir = git_dir.unwrap();
        
        // Helper to read file from git dir
        let read_file = |relative: &str| -> Option<String> {
            let path = git_dir.join(relative);
            std::fs::read_to_string(path).ok()?.trim().to_string().into()
        };

        // Helper to check if file exists
        let exists = |relative: &str| -> bool {
            git_dir.join(relative).exists()
        };

        // Helper to shorten ref
        let shorten_ref = |value: Option<&str>| -> Option<String> {
            value.map(|v| v[..8.min(v.len())].to_string())
        };

        // Check for rebase-merge
        if exists("rebase-merge") {
            let head = read_file("rebase-merge/head-name");
            let onto = read_file("rebase-merge/onto");
            let msgnum = read_file("rebase-merge/msgnum").and_then(|s| s.parse::<u32>().ok());
            let end = read_file("rebase-merge/end").and_then(|s| s.parse::<u32>().ok());
            
            return Ok(GitOperationState {
                kind: GitOperationKind::Rebase,
                head_short: head.and_then(|h| h.strip_prefix("refs/heads/").map(|s| s.to_string())),
                onto_short: shorten_ref(onto.as_deref()),
                message: None,
                step_current: msgnum,
                step_total: end,
            });
        }

        // Check for rebase-apply
        if exists("rebase-apply") {
            let head = read_file("rebase-apply/head-name");
            let onto = read_file("rebase-apply/onto");
            let next = read_file("rebase-apply/next").and_then(|s| s.parse::<u32>().ok());
            let last = read_file("rebase-apply/last").and_then(|s| s.parse::<u32>().ok());
            
            return Ok(GitOperationState {
                kind: GitOperationKind::Rebase,
                head_short: head.and_then(|h| h.strip_prefix("refs/heads/").map(|s| s.to_string())),
                onto_short: shorten_ref(onto.as_deref()),
                message: None,
                step_current: next,
                step_total: last,
            });
        }

        // Check for merge
        if exists("MERGE_HEAD") {
            let merge_head = read_file("MERGE_HEAD");
            let merge_msg = read_file("MERGE_MSG");
            
            return Ok(GitOperationState {
                kind: GitOperationKind::Merge,
                head_short: shorten_ref(merge_head.as_deref().and_then(|s| s.lines().next())),
                onto_short: None,
                message: merge_msg.and_then(|m| m.lines().next().map(|s| s.to_string())),
                step_current: None,
                step_total: None,
            });
        }

        // Check for cherry-pick
        if exists("CHERRY_PICK_HEAD") {
            let head = read_file("CHERRY_PICK_HEAD");
            return Ok(GitOperationState {
                kind: GitOperationKind::CherryPick,
                head_short: shorten_ref(head.as_deref()),
                onto_short: None,
                message: None,
                step_current: None,
                step_total: None,
            });
        }

        // Check for revert
        if exists("REVERT_HEAD") {
            let head = read_file("REVERT_HEAD");
            return Ok(GitOperationState {
                kind: GitOperationKind::Revert,
                head_short: shorten_ref(head.as_deref()),
                onto_short: None,
                message: None,
                step_current: None,
                step_total: None,
            });
        }

        Ok(GitOperationState {
            kind: GitOperationKind::None,
            head_short: None,
            onto_short: None,
            message: None,
            step_current: None,
            step_total: None,
        })
    }

    /// Cherry-pick a commit
    pub async fn cherry_pick(&self, ref_: &str) -> GitResult<()> {
        self.run_git(&["cherry-pick", ref_]).await?;
        Ok(())
    }

    /// Cherry-pick a range of commits
    pub async fn cherry_pick_range(&self, from_exclusive: &str, to_inclusive: &str) -> GitResult<()> {
        self.run_git(&["cherry-pick", &format!("{}..{}", from_exclusive, to_inclusive)]).await?;
        Ok(())
    }

    /// Revert a commit
    pub async fn revert_commit(&self, ref_: &str) -> GitResult<()> {
        self.run_git(&["revert", ref_]).await?;
        Ok(())
    }

    /// Reset current branch to a ref
    pub async fn reset_current(&self, ref_: &str, mode: ResetMode) -> GitResult<()> {
        let mode_str = match mode {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        };
        self.run_git(&["reset", mode_str, ref_]).await?;
        Ok(())
    }

    /// Check if a commit is in the current branch
    pub async fn is_commit_in_current_branch(&self, sha: &str) -> bool {
        self.run_git(&["merge-base", "--is-ancestor", sha, "HEAD"])
            .await
            .is_ok()
    }

    /// Get stashes
    pub async fn get_stashes(&self) -> GitResult<Vec<StashEntry>> {
        let result = self.run_git(&[
            "reflog",
            "show",
            "refs/stash",
            "--date=iso-strict",
            &format!("--format=%gd{}%H{}%gs{}%an{}%aI{}", 
                FIELD_SEPARATOR, FIELD_SEPARATOR, FIELD_SEPARATOR, FIELD_SEPARATOR, RECORD_SEPARATOR),
        ]).await?;

        let mut entries: Vec<StashEntry> = result.stdout
            .split(RECORD_SEPARATOR)
            .map(|line| line.trim())
            .filter(|s| !s.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.split(FIELD_SEPARATOR).collect();
                if parts.len() < 5 {
                    return None;
                }

                let ref_raw = parts[0];
                let sha = parts[1].to_string();
                let subject = parts[2].to_string();
                let author = if parts[3].is_empty() { None } else { Some(parts[3].to_string()) };
                let timestamp = if parts[4].is_empty() { None } else { Some(parts[4].to_string()) };

                let index = ref_raw
                    .strip_prefix("stash@{")
                    .and_then(|s| s.strip_suffix("}"))
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(0);
                let r#ref = format!("stash@{{{}}}", index);
                let message = subject
                    .strip_prefix("On ")
                    .and_then(|s| s.split_once(':'))
                    .map(|(_, s)| s.trim())
                    .or_else(|| subject.strip_prefix("WIP on "))
                    .and_then(|s| s.split_once(':'))
                    .map(|(_, s)| s.trim())
                    .unwrap_or(&subject)
                    .to_string();

                Some(StashEntry {
                    index,
                    r#ref,
                    message,
                    author,
                    timestamp,
                    file_count: 0, // Will be populated separately
                    sha: Some(sha),
                })
            })
            .collect();

        // Populate file counts
        for entry in &mut entries {
            let file_count = self.get_stash_file_count(&entry.r#ref).await;
            entry.file_count = file_count;
        }

        entries.sort_by_key(|e| e.index);
        Ok(entries)
    }

    /// Create a stash
    pub async fn create_stash(&self, message: &str, options: StashOptions) -> GitResult<()> {
        let mut args = vec!["stash", "push", "-m", message];
        if options.include_untracked {
            args.push("-u");
        }
        if options.keep_index {
            args.push("--keep-index");
        }
        self.run_git(&args).await?;
        Ok(())
    }

    /// Apply a stash
    pub async fn apply_stash(&self, ref_: &str, pop: bool) -> GitResult<()> {
        let cmd = if pop { "pop" } else { "apply" };
        self.run_git(&["stash", cmd, ref_]).await?;
        Ok(())
    }

    /// Drop a stash
    pub async fn drop_stash(&self, ref_: &str) -> GitResult<()> {
        self.run_git(&["stash", "drop", ref_]).await?;
        Ok(())
    }

    /// Rename a stash
    pub async fn rename_stash(&self, ref_: &str, message: &str) -> GitResult<()> {
        let result = self.run_git(&["rev-parse", ref_]).await?;
        let stash_hash = result.stdout.trim();
        self.run_git(&["stash", "drop", ref_]).await?;
        self.run_git(&["stash", "store", "-m", message, stash_hash]).await?;
        Ok(())
    }

    /// Get stash patch
    pub async fn get_stash_patch(&self, ref_: &str) -> GitResult<String> {
        let result = self.run_git(&["stash", "show", "-p", ref_]).await?;
        Ok(result.stdout)
    }

    /// Get commit graph
    pub async fn get_graph(&self, max_count: u32, filters: Option<&GraphFilters>) -> GitResult<Vec<GraphCommit>> {
        let format = [
            "%m",
            "%H",
            "%h",
            "%P",
            "%D",
            "%an",
            "%aI",
            "%s",
        ].join(FIELD_SEPARATOR);

        let max_count_arg = format!("--max-count={}", max_count);
        let format_arg = format!("--format={}{}", format, RECORD_SEPARATOR);

        let mut args = vec![
            "log".to_string(),
            "--date=iso-strict".to_string(),
            "--decorate=full".to_string(),
            max_count_arg,
            format_arg,
        ];

        if let Some(f) = filters {
            if let Some(ref branch) = f.branch {
                args.push(branch.clone());
            }
            if let Some(ref author) = f.author {
                args.push(format!("--author={}", author));
            }
            if let Some(ref message) = f.message {
                args.push(format!("--grep={}", message));
            }
            if let Some(ref since) = f.since {
                args.push(format!("--since={}", since));
            }
            if let Some(ref until) = f.until {
                args.push(format!("--until={}", until));
            }
        }

        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let result = self.run_git(&arg_refs).await?;

        let commits = result.stdout
            .split(RECORD_SEPARATOR)
            .map(|line| line.trim())
            .filter(|s| !s.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.split(FIELD_SEPARATOR).collect();
                if parts.len() < 8 {
                    return None;
                }

                let graph = if parts[0].is_empty() { None } else { Some(parts[0].to_string()) };
                let sha = parts[1].to_string();
                let short_sha = parts[2].to_string();
                let parents = parts[3]
                    .split_whitespace()
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect();
                let refs = parts[4]
                    .split(',')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .collect();
                let author = parts[5].to_string();
                let date = parts[6].to_string();
                let subject = parts[7].to_string();

                Some(GraphCommit {
                    graph,
                    sha,
                    short_sha,
                    parents,
                    refs,
                    author,
                    date,
                    subject,
                    stats: None,
                })
            })
            .collect();

        Ok(commits)
    }

    /// Get commit details
    pub async fn get_commit_details(&self, sha: &str) -> GitResult<CommitDetails> {
        let mut commits = self.get_graph(1, Some(&GraphFilters { branch: Some(sha.to_string()), ..Default::default() })).await?;
        let commit = commits.pop().ok_or_else(|| GitError::ParseError(format!("Commit {} not found", sha)))?;

        let body_result = self.run_git(&["show", "--quiet", "--format=%B", sha]).await?;
        let name_status = self.run_git(&["show", "--name-status", "--format=", sha]).await?;
        let short_stat = self.run_git(&["show", "--shortstat", "--format=", sha]).await?;

        let changed_files = name_status.stdout
            .lines()
            .map(|line| line.trim())
            .filter(|s| !s.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() >= 2 {
                    Some(CommitFileChange {
                        status: parts[0].to_string(),
                        path: parts[1].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();

        let stats = parse_short_stat(&short_stat.stdout);

        Ok(CommitDetails {
            commit: GraphCommit { stats, ..commit },
            body: body_result.stdout.trim().to_string(),
            changed_files,
        })
    }

    /// Get parent commit SHA
    pub async fn get_parent_commit(&self, sha: &str) -> GitResult<Option<String>> {
        let result = self.run_git(&["rev-list", "--parents", "-n", "1", sha]).await?;
        let tokens: Vec<&str> = result.stdout.trim().split_whitespace().collect();
        
        if tokens.len() < 2 {
            return Ok(None);
        }
        
        Ok(Some(tokens[1].to_string()))
    }

    /// Get files at a revision
    pub async fn get_files_at_revision(&self, ref_: &str) -> GitResult<Vec<String>> {
        let result = self.run_git(&["ls-tree", "-r", "--name-only", ref_]).await?;
        Ok(result.stdout
            .lines()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect())
    }

    /// Get patch for a commit
    pub async fn get_patch_for_commit(&self, sha: &str) -> GitResult<String> {
        let result = self.run_git(&["format-patch", "--stdout", "-1", sha]).await?;
        Ok(result.stdout)
    }

    /// Compare two refs
    pub async fn get_compare(&self, left_ref: &str, right_ref: &str) -> GitResult<CompareResult> {
        let format = [
            "%m",
            "%H",
            "%h",
            "%P",
            "%D",
            "%an",
            "%aI",
            "%s",
        ].join(FIELD_SEPARATOR);

        let left_only = self.run_git(&[
            "log",
            "--date=iso-strict",
            &format!("--format={}{}", format, RECORD_SEPARATOR),
            &format!("{}..{}", right_ref, left_ref),
        ]).await?;

        let right_only = self.run_git(&[
            "log",
            "--date=iso-strict",
            &format!("--format={}{}", format, RECORD_SEPARATOR),
            &format!("{}..{}", left_ref, right_ref),
        ]).await?;

        let diff_names = self.run_git(&["diff", "--name-status", &format!("{}...{}", left_ref, right_ref)]).await?;

        let commits_only_left = parse_graph_rows(&left_only.stdout);
        let commits_only_right = parse_graph_rows(&right_only.stdout);

        let changed_files = diff_names.stdout
            .lines()
            .map(|line| line.trim())
            .filter(|s| !s.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() >= 2 {
                    Some(ChangedFile {
                        status: parts[0].to_string(),
                        path: parts[1].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();

        Ok(CompareResult {
            left_ref: left_ref.to_string(),
            right_ref: right_ref.to_string(),
            commits_only_left,
            commits_only_right,
            changed_files,
        })
    }

    /// Get changed files in working tree
    pub async fn get_changed_files(&self) -> GitResult<Vec<WorkingTreeChange>> {
        let result = self.run_git(&["status", "--porcelain"]).await?;
        Ok(result.stdout
            .lines()
            .map(|line| line.replace("\r", ""))
            .filter(|s| !s.is_empty())
            .map(|line| {
                let status = line[..2].to_string();
                let path = line[3..].to_string();
                WorkingTreeChange { status, path }
            })
            .collect())
    }

    /// Stash specific files
    pub async fn stash_files(&self, paths: &[&str], message: &str, keep_index: bool) -> GitResult<()> {
        if paths.is_empty() {
            return Ok(());
        }

        let mut args = vec!["stash", "push", "-m", message];
        if keep_index {
            args.push("--keep-index");
        }
        args.push("--");
        for path in paths {
            args.push(path);
        }
        
        self.run_git(&args).await?;
        Ok(())
    }

    /// Get staged files
    pub async fn get_staged_files(&self) -> GitResult<Vec<String>> {
        let result = self.run_git(&["diff", "--cached", "--name-only"]).await?;
        Ok(result.stdout
            .lines()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect())
    }

    /// Get merge conflicts
    pub async fn get_merge_conflicts(&self) -> GitResult<Vec<MergeConflictFile>> {
        let result = self.run_git(&["diff", "--name-status", "--diff-filter=U"]).await?;
        Ok(result.stdout
            .lines()
            .map(|line| line.trim())
            .filter(|s| !s.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() >= 2 {
                    Some(MergeConflictFile {
                        status: parts[0].to_string(),
                        path: parts[1].to_string(),
                    })
                } else {
                    None
                }
            })
            .collect())
    }

    /// Stage a file
    pub async fn stage_file(&self, path: &str) -> GitResult<()> {
        self.run_git(&["add", "--", path]).await?;
        Ok(())
    }

    /// Unstage a file
    pub async fn unstage_file(&self, path: &str) -> GitResult<()> {
        self.run_git(&["restore", "--staged", "--", path]).await?;
        Ok(())
    }

    /// Get outgoing/incoming commit preview
    pub async fn get_outgoing_incoming_preview(&self) -> GitResult<(Vec<String>, Vec<String>)> {
        let branch = self.get_current_branch().await?;
        
        let upstream = match self.run_git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", &format!("{}@{{upstream}}", branch)]).await {
            Ok(result) => result.stdout.trim().to_string(),
            Err(_) => return Ok((vec![], vec![])),
        };

        let outgoing = self.run_git(&["log", "--oneline", &format!("{}..{}", upstream, branch)]).await?;
        let incoming = self.run_git(&["log", "--oneline", &format!("{}..{}", branch, upstream)]).await?;

        Ok((
            outgoing.stdout.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
            incoming.stdout.lines().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        ))
    }

    /// Push changes
    pub async fn push(&self) -> GitResult<()> {
        self.run_git(&["push"]).await?;
        Ok(())
    }

    /// Pull changes
    pub async fn pull(&self) -> GitResult<()> {
        self.run_git(&["pull"]).await?;
        Ok(())
    }

    /// Fetch with prune
    pub async fn fetch_prune(&self) -> GitResult<()> {
        self.run_git(&["fetch", "--prune"]).await?;
        Ok(())
    }

    /// Add all files
    pub async fn add_all(&self) -> GitResult<()> {
        self.run_git(&["add", "-A"]).await?;
        Ok(())
    }

    /// Stage patch (interactive)
    pub async fn stage_patch(&self, file_path: &str) -> GitResult<()> {
        self.run_git(&["add", "-p", "--", file_path]).await?;
        Ok(())
    }

    /// Amend commit
    pub async fn amend_commit(&self, message: Option<&str>) -> GitResult<()> {
        let mut args = vec!["commit", "--amend"];
        if let Some(msg) = message {
            args.extend_from_slice(&["-m", msg]);
        } else {
            args.push("--no-edit");
        }
        self.run_git(&args).await?;
        Ok(())
    }

    /// Commit changes
    pub async fn commit(&self, message: &str) -> GitResult<()> {
        self.run_git(&["commit", "-m", message]).await?;
        Ok(())
    }

    /// Commit only specified paths
    pub async fn commit_only(&self, message: &str, paths: &[&str]) -> GitResult<()> {
        if paths.is_empty() {
            return Err(GitError::CommandFailed("No paths provided for commit".to_string()));
        }
        
        let mut args = vec!["commit", "--only", "-m", message, "--"];
        for path in paths {
            args.push(path);
        }
        
        self.run_git(&args).await?;
        Ok(())
    }

    /// Get HEAD commit message
    pub async fn get_head_commit_message(&self) -> GitResult<String> {
        let result = self.run_git(&["log", "-1", "--pretty=%B"]).await?;
        Ok(result.stdout.trim().to_string())
    }

    /// Unstage all files
    pub async fn unstage_all(&self) -> GitResult<()> {
        self.run_git(&["restore", "--staged", "."]).await?;
        Ok(())
    }

    /// Discard file changes
    pub async fn discard_file(&self, file_path: &str, is_untracked: bool) -> GitResult<()> {
        if is_untracked {
            self.run_git(&["clean", "-f", "--", file_path]).await?;
        } else {
            self.run_git(&["restore", "--", file_path]).await?;
        }
        Ok(())
    }

    /// Get file history
    pub async fn file_history(&self, path: &str) -> GitResult<Vec<GraphCommit>> {
        let format = [
            "%m",
            "%H",
            "%h",
            "%P",
            "%D",
            "%an",
            "%aI",
            "%s",
        ].join(FIELD_SEPARATOR);

        let result = self.run_git(&[
            "log",
            "--date=iso-strict",
            "--follow",
            &format!("--format={}", format),
            "--",
            path,
        ]).await?;

        Ok(parse_graph_rows(&result.stdout))
    }

    /// Get file blame
    pub async fn file_blame(&self, path: &str) -> GitResult<String> {
        let result = self.run_git(&["blame", "--", path]).await?;
        Ok(result.stdout)
    }

    /// Get file content from a ref
    pub async fn get_file_content_from_ref(&self, ref_spec: &str, relative_path: &str) -> GitResult<String> {
        if ref_spec == "WORKTREE" {
            let absolute_path = self.context.root_path.join(relative_path);
            return Ok(std::fs::read_to_string(absolute_path)?);
        }

        if ref_spec == "INDEX" {
            let result = self.run_git(&["show", &format!(":{}", relative_path)]).await?;
            return Ok(result.stdout);
        }

        let result = self.run_git(&["show", &format!("{}:{}", ref_spec, relative_path)]).await?;
        Ok(result.stdout)
    }

    /// Get files in a commit
    pub async fn get_files_in_commit(&self, sha: &str) -> GitResult<Vec<String>> {
        let entries = self.get_files_in_commit_with_status(sha).await?;
        Ok(entries.into_iter().map(|e| e.path).collect())
    }

    /// Get files in a commit with status
    pub async fn get_files_in_commit_with_status(&self, sha: &str) -> GitResult<Vec<CommitFileChange>> {
        let result = self.run_git(&["show", "--name-status", "--pretty=format:", sha]).await?;
        Ok(result.stdout
            .lines()
            .map(|line| line.trim())
            .filter(|s| !s.is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.split('\t').filter(|s| !s.is_empty()).collect();
                if parts.len() >= 2 {
                    Some(CommitFileChange {
                        status: parts[0].to_string(),
                        path: parts.last()?.to_string(),
                    })
                } else {
                    None
                }
            })
            .collect())
    }

    /// Get files changed between two refs
    pub async fn get_files_changed_between(&self, left_ref: &str, right_ref: &str) -> GitResult<Vec<String>> {
        let result = self.run_git(&["diff", "--name-only", &format!("{}...{}", left_ref, right_ref)]).await?;
        Ok(result.stdout
            .lines()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect())
    }

    /// Run a git command
    async fn run_git(&self, args: &[&str]) -> GitResult<GitCommandResult> {
        let timeout = Duration::from_millis(self.config.timeout_ms);
        
        let mut cmd = Command::new(&self.config.git_path);
        cmd.args(args)
            .current_dir(&self.context.root_path);

        let output = tokio::time::timeout(timeout, cmd.output())
            .await
            .map_err(|_| GitError::Timeout(format!("git {} timed out", args.join(" "))))?
            .map_err(|e| GitError::GitNotFound(e.to_string()))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if output.status.success() {
            Ok(GitCommandResult { stdout, stderr })
        } else {
            Err(GitError::CommandFailed(stderr))
        }
    }

    /// Get the git directory path
    async fn get_git_dir(&self) -> GitResult<Option<PathBuf>> {
        {
            let cache = self.git_dir_cache.read().await;
            if let Some(cached) = &*cache {
                return Ok(Some(cached.clone()));
            }
        }

        match self.run_git(&["rev-parse", "--git-dir"]).await {
            Ok(result) => {
                let raw = result.stdout.trim();
                if raw.is_empty() {
                    return Ok(None);
                }

                let resolved = if raw.starts_with('/') {
                    PathBuf::from(raw)
                } else {
                    self.context.root_path.join(raw)
                };

                let mut cache = self.git_dir_cache.write().await;
                *cache = Some(resolved.clone());
                Ok(Some(resolved))
            }
            Err(_) => Ok(None),
        }
    }

    /// Get stash file count
    async fn get_stash_file_count(&self, ref_: &str) -> u32 {
        match self.run_git(&["stash", "show", "--name-only", ref_]).await {
            Ok(result) => result.stdout
                .lines()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .count() as u32,
            Err(_) => 0,
        }
    }
}

/// Parse upstream track information
fn parse_track(value: &str) -> (u32, u32) {
    if value.is_empty() {
        return (0, 0);
    }

    let ahead = value
        .find("ahead ")
        .and_then(|i| value[i + 6..].split_whitespace().next())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    let behind = value
        .find("behind ")
        .and_then(|i| value[i + 7..].split_whitespace().next())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    (ahead, behind)
}

/// Parse graph rows from git log output
fn parse_graph_rows(raw: &str) -> Vec<GraphCommit> {
    raw.split(RECORD_SEPARATOR)
        .map(|line| line.trim())
        .filter(|s| !s.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(FIELD_SEPARATOR).collect();
            if parts.len() < 8 {
                return None;
            }

            let graph = if parts[0].is_empty() { None } else { Some(parts[0].to_string()) };
            let sha = parts[1].to_string();
            let short_sha = parts[2].to_string();
            let parents = parts[3]
                .split_whitespace()
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
            let refs = parts[4]
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
            let author = parts[5].to_string();
            let date = parts[6].to_string();
            let subject = parts[7].to_string();

            Some(GraphCommit {
                graph,
                sha,
                short_sha,
                parents,
                refs,
                author,
                date,
                subject,
                stats: None,
            })
        })
        .collect()
}

/// Parse short stat output
fn parse_short_stat(raw: &str) -> Option<CommitStats> {
    let line = raw.lines().map(|s| s.trim()).find(|s| !s.is_empty())?;

    let files = line
        .find("file")
        .and_then(|i| line[..i].trim_end().split_whitespace().last())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    let insertions = line
        .find("insertion")
        .and_then(|i| line[..i].trim_end().split_whitespace().last())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    let deletions = line
        .find("deletion")
        .and_then(|i| line[..i].trim_end().split_whitespace().last())
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    Some(CommitStats {
        files,
        insertions,
        deletions,
    })
}
