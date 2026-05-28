// src/event.rs
/// Core events raised by the watcher.
pub enum AppEvent {
    /// New file/directory added/created at a monitored path.
    FileAdded(FileAddedPayload),
    /// Content of a watch‑path entry has changed (modified).
    FileModified(FileModifiedPayload),
    /// Entry was removed/deleted from the watched directory tree.
    FileRemoved(FileRemovedPayload),
}

/// Payload for `AppEvent::FileAdded`.
pub struct FileAddedPayload {
    pub path: String,
    #[cfg_attr(test, allow(dead_code))] // useful in tests only
    pub timestamp: std::time::SystemTime,
}

/// Payload for `AppEvent::FileModified`.
pub struct FileModifiedPayload {
    pub path: String,
    #[cfg_attr(test, allow(dead_code))]
    pub modified_at: std::time::SystemTime,
}

/// Payload for `AppEvent::FileRemoved`.
pub struct FileRemovedPayload {
    pub path: String,
    #[cfg_attr(test, allow(dead_code))]
    pub removed_at: std::time::SystemTime,
}
