//! Branches panel module for IntelliGit Zed extension
//!
//! This module provides the branches tree view functionality,
//! mirroring the VSCode version's branchTreeProvider.ts

use crate::types::{BranchRef, BranchType};

/// Node types for the branch tree
pub enum BranchTreeNode {
    /// Top-level section (Recent, Local, Remote)
    Section {
        kind: BranchSectionKind,
        branches: Vec<BranchRef>,
        count: u32,
    },
    /// Remote group node (origin, upstream, etc.)
    RemoteGroup {
        remote_name: String,
        branches: Vec<BranchRef>,
    },
    /// Path group node (feature/, release/, etc.)
    PathGroup {
        id_prefix: String,
        segment: String,
        full_path: String,
        branches: Vec<BranchRef>,
    },
    /// Leaf branch item
    Branch(BranchRef),
}

/// Branch section kind
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BranchSectionKind {
    Recent,
    Local,
    Remote,
}

impl BranchSectionKind {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Recent => "Recent",
            Self::Local => "Local",
            Self::Remote => "Remote",
        }
    }
}

/// Build the branch tree structure
pub fn build_branch_tree(branches: &[BranchRef], filter_text: Option<&str>) -> Vec<BranchTreeNode> {
    // Apply filter if provided
    let filtered: Vec<BranchRef> = if let Some(filter) = filter_text {
        let filter_lower = filter.to_lowercase();
        branches
            .iter()
            .filter(|b| {
                b.name.to_lowercase().contains(&filter_lower)
                    || b.short_name.to_lowercase().contains(&filter_lower)
            })
            .cloned()
            .collect()
    } else {
        branches.to_vec()
    };

    let local_branches: Vec<BranchRef> = filtered
        .iter()
        .filter(|b| b.branch_type == BranchType::Local)
        .cloned()
        .collect();

    let remote_branches: Vec<BranchRef> = filtered
        .iter()
        .filter(|b| b.branch_type == BranchType::Remote)
        .cloned()
        .collect();

    let recent_branches = get_recent_branches(branches, 5);

    let mut nodes = Vec::new();

    // Add recent section if there are recent branches
    if !recent_branches.is_empty() {
        nodes.push(BranchTreeNode::Section {
            kind: BranchSectionKind::Recent,
            branches: recent_branches.clone(),
            count: recent_branches.len() as u32,
        });
    }

    // Add local section if there are local branches
    if !local_branches.is_empty() {
        nodes.push(BranchTreeNode::Section {
            kind: BranchSectionKind::Local,
            branches: local_branches.clone(),
            count: local_branches.len() as u32,
        });
    }

    // Add remote section if there are remote branches
    if !remote_branches.is_empty() {
        nodes.push(BranchTreeNode::Section {
            kind: BranchSectionKind::Remote,
            branches: remote_branches.clone(),
            count: remote_branches.len() as u32,
        });
    }

    nodes
}

/// Get children of a section node
pub fn get_section_children(section: &BranchTreeNode) -> Vec<BranchTreeNode> {
    match section {
        BranchTreeNode::Section { kind, branches, .. } => {
            match kind {
                BranchSectionKind::Remote => {
                    // Group by remote name
                    build_remote_nodes(branches)
                }
                _ => {
                    // Build path nodes for local/recent
                    let path_mode = if *kind == BranchSectionKind::Local {
                        PathMode::Name
                    } else {
                        PathMode::ShortName
                    };
                    build_path_nodes(branches, "", path_mode, &format!("{:?}", kind))
                }
            }
        }
        BranchTreeNode::RemoteGroup { remote_name, branches } => {
            build_path_nodes(branches, "", PathMode::ShortName, &format!("remote:{}", remote_name))
        }
        BranchTreeNode::PathGroup { full_path, branches, id_prefix, .. } => {
            let path_mode = if id_prefix.starts_with("remote:") {
                PathMode::ShortName
            } else if id_prefix.contains("Local") {
                PathMode::Name
            } else {
                PathMode::ShortName
            };
            build_path_nodes(branches, full_path, path_mode, id_prefix)
        }
        BranchTreeNode::Branch(_) => vec![],
    }
}

/// Build remote group nodes
fn build_remote_nodes(branches: &[BranchRef]) -> Vec<BranchTreeNode> {
    use std::collections::HashMap;
    
    let mut by_remote: HashMap<String, Vec<BranchRef>> = HashMap::new();
    
    for branch in branches {
        let remote = branch.remote_name.clone().unwrap_or_else(|| "unknown".to_string());
        by_remote.entry(remote).or_insert_with(Vec::new).push(branch.clone());
    }

    let mut remote_nodes: Vec<BranchTreeNode> = by_remote
        .into_iter()
        .map(|(remote_name, remote_branches)| {
            BranchTreeNode::RemoteGroup {
                remote_name,
                branches: remote_branches,
            }
        })
        .collect();

    remote_nodes.sort_by(|a, b| {
        match (a, b) {
            (BranchTreeNode::RemoteGroup { remote_name: a, .. }, 
             BranchTreeNode::RemoteGroup { remote_name: b, .. }) => {
                a.cmp(b)
            }
            _ => std::cmp::Ordering::Equal,
        }
    });

    remote_nodes
}

/// Path mode for building path nodes
enum PathMode {
    Name,
    ShortName,
}

/// Build path group nodes
fn build_path_nodes(
    branches: &[BranchRef],
    base_path: &str,
    path_mode: PathMode,
    id_prefix: &str,
) -> Vec<BranchTreeNode> {
    use std::collections::HashMap;

    let mut groups: HashMap<String, Vec<BranchRef>> = HashMap::new();
    let mut leaves: Vec<BranchTreeNode> = Vec::new();

    for branch in branches {
        let branch_path = match path_mode {
            PathMode::Name => &branch.name,
            PathMode::ShortName => &branch.short_name,
        };

        let relative_name = if base_path.is_empty() {
            branch_path.clone()
        } else if branch_path.starts_with(base_path) {
            branch_path[base_path.len() + 1..].to_string()
        } else {
            continue;
        };

        let parts: Vec<&str> = relative_name.split('/').collect();
        
        if parts.len() <= 1 {
            // Leaf node
            leaves.push(BranchTreeNode::Branch(branch.clone()));
            continue;
        }

        let segment = parts[0].to_string();
        let child_path = if base_path.is_empty() {
            segment.clone()
        } else {
            format!("{}/{}", base_path, segment)
        };

        groups.entry(child_path).or_insert_with(Vec::new).push(branch.clone());
    }

    let mut group_items: Vec<BranchTreeNode> = groups
        .into_iter()
        .map(|(full_path, branch_set)| {
            let segment = full_path.split('/').last().unwrap_or(&full_path).to_string();
            BranchTreeNode::PathGroup {
                id_prefix: id_prefix.to_string(),
                segment,
                full_path,
                branches: branch_set,
            }
        })
        .collect();

    group_items.sort_by(|a, b| {
        match (a, b) {
            (BranchTreeNode::PathGroup { segment: a, .. }, 
             BranchTreeNode::PathGroup { segment: b, .. }) => {
                a.cmp(b)
            }
            _ => std::cmp::Ordering::Equal,
        }
    });

    // Sort leaves: current branch first, then alphabetically
    leaves.sort_by(|a, b| {
        match (a, b) {
            (BranchTreeNode::Branch(a_ref), BranchTreeNode::Branch(b_ref)) => {
                if a_ref.current {
                    std::cmp::Ordering::Less
                } else if b_ref.current {
                    std::cmp::Ordering::Greater
                } else {
                    let a_path = match path_mode {
                        PathMode::Name => &a_ref.name,
                        PathMode::ShortName => &a_ref.short_name,
                    };
                    let b_path = match path_mode {
                        PathMode::Name => &b_ref.name,
                        PathMode::ShortName => &b_ref.short_name,
                    };
                    a_path.cmp(b_path)
                }
            }
            _ => std::cmp::Ordering::Equal,
        }
    });

    let mut result = group_items;
    result.extend(leaves);
    result
}

/// Get recent branches sorted by last commit date
fn get_recent_branches(branches: &[BranchRef], max: usize) -> Vec<BranchRef> {
    let mut sorted: Vec<BranchRef> = branches.to_vec();
    
    sorted.sort_by(|a, b| {
        // Current branch first
        if a.current {
            return std::cmp::Ordering::Less;
        }
        if b.current {
            return std::cmp::Ordering::Greater;
        }

        // Then by last commit epoch (descending)
        match (a.last_commit_epoch, b.last_commit_epoch) {
            (Some(a_epoch), Some(b_epoch)) => b_epoch.cmp(&a_epoch),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => a.name.cmp(&b.name),
        }
    });

    sorted.into_iter().take(max).collect()
}

/// Describe a branch for display
pub fn describe_branch(branch: &BranchRef) -> String {
    let mut parts: Vec<String> = Vec::new();

    if branch.current {
        parts.push("current".to_string());
    }

    if branch.branch_type == BranchType::Remote {
        parts.push("remote".to_string());
    }

    if let Some(ref upstream) = branch.upstream {
        parts.push(format!("upstream: {}", upstream));
    }

    if branch.ahead > 0 || branch.behind > 0 {
        parts.push(format!("▲{} ▼{}", branch.ahead, branch.behind));
    }

    parts.join(" · ")
}
