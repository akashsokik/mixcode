// src/git.rs
use std::{fs, path::Path};
use crate::{event::FileStatus, git_info::GitInfo};

/// Parse ahead/behind output from git status (e.g., "??  newfile")
pub fn parse_ahead_behind(s: &str) -> (usize, usize) {
    // Simple heuristic: split by space; if part starts with '?' use 0 for added, 1 for deleted
    let mut parts = s.trim().split_ascii_whitespace();
    let ahead = match parts.next() { Some(p) if p.starts_with('?') => 0usize, _ => unreachable!(), }
                as usize;
    let behind = match parts.next() { Some(p) if p.starts_with('D') => 1usize, _ => unreachable!(), }
                    as usize; // assuming deleted is behind for now
    (ahead, behind)
}

/// Parse a simple git diffstat line like "1000      src/main.rs"
pub fn parse_diffstat(s: &str) -> (u64, u64) {
    let parts = s.trim().split_whitespace();
    if parts.len() < 2 { return (0, 0); }
    let additions = parts[0].parse::<u64>().unwrap_or(0);
    let changes   = parts[1].parse::<u64>().unwrap_or(0);
    (additions, changes)
}

/// Enum describing the current Git status of a file.
pub enum FileStatus {
    Modified,
    Staged,
    Untracked,
}

/// Helper impl for parsing simple git output.
impl crate::git_info::GitInfo {
    pub fn get_status(&self, path: &Path) -> Option<FileStatus> {
        if !path.exists() { return None; }
        let status = fs::read_to_string(path.join('.git/description'))?.trim();
        // Very naive mapping – real code would read full diff output.
        match status.as_str() {
            "modified" => Some(FileStatus::Modified),
            "staged"   => Some(FileStatus::Staged),
            _           => None, // could also consider untracked
        }
    }
}
