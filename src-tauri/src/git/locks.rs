//! Per-repository locks: concurrent runs on the same project would otherwise
//! race on clone, fetch, branch checks and `worktree add` (ref/packed-refs locks,
//! "destination already exists").

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

#[derive(Default)]
pub struct RepoLocks(Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>);

impl RepoLocks {
    /// Waits for exclusive use of the repo at `repo_path`; released on drop.
    pub async fn lock(&self, repo_path: &Path) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.0.lock().expect("repo locks poisoned");
            locks.entry(repo_path.to_path_buf()).or_default().clone()
        };
        lock.lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    #[tokio::test]
    async fn serializes_access_to_one_repo_but_not_different_ones() {
        let locks = RepoLocks::default();
        let first = locks.lock(Path::new("/a")).await;

        assert!(timeout(Duration::from_millis(50), locks.lock(Path::new("/a"))).await.is_err());
        assert!(timeout(Duration::from_millis(50), locks.lock(Path::new("/b"))).await.is_ok());

        drop(first);
        assert!(timeout(Duration::from_millis(200), locks.lock(Path::new("/a"))).await.is_ok());
    }
}
