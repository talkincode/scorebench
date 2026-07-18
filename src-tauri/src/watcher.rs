use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::error::BenchError;

const DEBOUNCE: Duration = Duration::from_millis(180);

#[derive(Debug, Clone, Serialize)]
struct ProjectChanged {
    root: PathBuf,
}

struct Registration {
    _watcher: RecommendedWatcher,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub struct ProjectWatcher {
    registration: Mutex<Option<Registration>>,
}

impl ProjectWatcher {
    pub fn watch(&self, app: AppHandle, root: PathBuf) -> Result<(), BenchError> {
        let (sender, receiver) = mpsc::unbounded_channel();
        let mut watcher = RecommendedWatcher::new(
            move |event: notify::Result<notify::Event>| {
                if event.is_ok() {
                    let _ = sender.send(());
                }
            },
            Config::default(),
        )
        .map_err(BenchError::io)?;
        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(BenchError::io)?;
        let event_root = root.clone();
        let task = tauri::async_runtime::spawn(run_debouncer(receiver, move || {
            let _ = app.emit(
                "project-changed",
                ProjectChanged {
                    root: event_root.clone(),
                },
            );
        }));
        let mut registration = self.registration.lock().map_err(|_| {
            BenchError::agent("watcher_poisoned", "project watcher lock is poisoned")
        })?;
        *registration = Some(Registration {
            _watcher: watcher,
            task,
        });
        Ok(())
    }
}

async fn run_debouncer(mut receiver: mpsc::UnboundedReceiver<()>, mut emit: impl FnMut()) {
    while receiver.recv().await.is_some() {
        tokio::time::sleep(DEBOUNCE).await;
        while receiver.try_recv().is_ok() {}
        emit();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use super::*;

    #[tokio::test]
    async fn event_storm_is_coalesced() {
        let (sender, receiver) = mpsc::unbounded_channel();
        let count = Arc::new(AtomicUsize::new(0));
        let emitted = Arc::clone(&count);
        let task = tokio::spawn(run_debouncer(receiver, move || {
            emitted.fetch_add(1, Ordering::SeqCst);
        }));
        for _ in 0..100 {
            sender.send(()).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(260)).await;
        drop(sender);
        task.await.unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }
}
