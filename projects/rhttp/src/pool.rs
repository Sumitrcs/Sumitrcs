use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

type Job = Box<dyn FnOnce() + Send + 'static>;

/// Fixed-size pool of worker threads fed through a channel.
/// Dropping the pool closes the channel and joins every worker.
pub struct ThreadPool {
    workers: Vec<JoinHandle<()>>,
    sender: Option<Sender<Job>>,
}

impl ThreadPool {
    pub fn new(size: usize) -> Self {
        assert!(size > 0, "thread pool needs at least one worker");
        let (sender, receiver) = mpsc::channel::<Job>();
        let receiver: Arc<Mutex<Receiver<Job>>> = Arc::new(Mutex::new(receiver));
        let workers = (0..size)
            .map(|id| {
                let rx = Arc::clone(&receiver);
                thread::Builder::new()
                    .name(format!("rhttp-worker-{id}"))
                    .spawn(move || {
                        loop {
                            // Hold the lock only while receiving, not while running the job.
                            let job = match rx.lock() {
                                Ok(guard) => guard.recv(),
                                Err(_) => break,
                            };
                            match job {
                                Ok(job) => {
                                    // A panicking handler must not kill the worker.
                                    let _ =
                                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
                                }
                                Err(_) => break, // channel closed: shutting down
                            }
                        }
                    })
                    .expect("failed to spawn worker thread")
            })
            .collect();
        ThreadPool {
            workers,
            sender: Some(sender),
        }
    }

    pub fn execute<F: FnOnce() + Send + 'static>(&self, f: F) {
        if let Some(tx) = &self.sender {
            let _ = tx.send(Box::new(f));
        }
    }

    pub fn size(&self) -> usize {
        self.workers.len()
    }
}

impl Drop for ThreadPool {
    fn drop(&mut self) {
        drop(self.sender.take());
        for w in self.workers.drain(..) {
            let _ = w.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn runs_all_jobs_and_survives_panics() {
        let counter = Arc::new(AtomicUsize::new(0));
        {
            let pool = ThreadPool::new(4);
            for i in 0..100 {
                let c = Arc::clone(&counter);
                pool.execute(move || {
                    if i == 50 {
                        panic!("handler bug");
                    }
                    c.fetch_add(1, Ordering::SeqCst);
                });
            }
        } // drop joins workers
        assert_eq!(counter.load(Ordering::SeqCst), 99);
    }
}
