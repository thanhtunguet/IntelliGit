//! IntelliGit Zed Extension - Main entry point
//!
//! This extension provides a JetBrains-like Git client for Zed IDE.

mod types;
mod git_service;
mod state;
mod panels;

use zed_extension_api as zed;

struct IntelliGitExtension;

impl zed::Extension for IntelliGitExtension {
    fn new() -> Self {
        Self
    }
}

zed_extension_api::register_extension!(IntelliGitExtension);
