// src/app.rs
use std::{path::PathBuf, sync::Arc};

/// Main application state.
#[derive(Debug)]
pub struct AppState {
    /// Path to watch (relative to repo root).
    pub config: Config,
}

/// Configuration options for the watcher.
#[derive(Debug, Clone)]
pub struct Config {
    /// Directory to monitor relative to repository root.
    pub root_path: String,
    /// Maximum polling interval in milliseconds (default 500).
    #[allow(dead_code)] // we may expose a setter later
    pub refresh_interval: u64,
}

impl AppState {
    /// Public entry point – creates an instance with sensible defaults.
    pub fn new() -> Self {
        let default_path = "src".to_string();
        println!("Initializing watcher for \"{}\" at path (relative to repo root) '{}'.", env!(ID), default_path);
        AppState { config: Config { root_path: default_path, refresh_interval: 500 } }
    }
}
