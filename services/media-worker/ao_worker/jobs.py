"""In-memory job queue: at most MAX_RUNNING jobs at once, cancellable, child processes in their own group.

The Node side owns persistence; a restarted worker starts with no jobs.
"""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable

log = logging.getLogger("ao_worker.jobs")

MAX_RUNNING = 2
KILL_GRACE_SEC = 3.0

JOB_TYPES = ("audio.transcribe", "capture.download", "image.proxy", "video.proxy", "pdf.ocr")


class JobError(Exception):
    """A job failure with a stable code. `message` and `detail` must not contain user file paths or full URLs."""

    def __init__(self, code: str, message: str, detail: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


class JobCancelled(Exception):
    pass


@dataclass
class Job:
    id: str
    type: str
    input: str
    output: str
    params: dict
    status: str = "queued"
    progress: float = 0.0
    result: dict | None = None
    error: dict | None = None
    created: float = field(default_factory=time.time)
    cancel_event: threading.Event = field(default_factory=threading.Event)
    procs: list = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def to_json(self) -> dict:
        out: dict[str, Any] = {"id": self.id, "type": self.type, "status": self.status, "progress": round(self.progress, 4)}
        if self.result is not None:
            out["result"] = self.result
        if self.error is not None:
            out["error"] = self.error
        return out


class JobContext:
    """What a handler gets: progress reporting, cancellation checks and process spawning."""

    def __init__(self, job: Job):
        self.job = job

    @property
    def cancelled(self) -> bool:
        return self.job.cancel_event.is_set()

    def check_cancelled(self) -> None:
        if self.cancelled:
            raise JobCancelled()

    def progress(self, value: float) -> None:
        self.job.progress = max(self.job.progress, min(1.0, max(0.0, float(value))))

    def popen(self, argv: list[str], **kw) -> subprocess.Popen:
        """Starts a child in its own process group (killed as a group on cancel)."""
        self.check_cancelled()
        if os.name == "nt":
            kw.setdefault("creationflags", subprocess.CREATE_NEW_PROCESS_GROUP)
        else:
            kw.setdefault("start_new_session", True)
        p = subprocess.Popen(argv, **kw)
        with self.job.lock:
            self.job.procs.append(p)
            cancelled = self.job.cancel_event.is_set()
        if cancelled:
            kill_tree(p)
        return p

    def wait(self, p: subprocess.Popen) -> int:
        """Waits for a child; raises JobCancelled when the job was cancelled meanwhile."""
        rc = p.wait()
        with self.job.lock:
            if p in self.job.procs:
                self.job.procs.remove(p)
        self.check_cancelled()
        return rc


def kill_tree(p: subprocess.Popen) -> None:
    """Terminates a child's whole process group, then kills what is left after a grace period."""
    if p.poll() is not None and os.name == "nt":
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True)
        return
    try:
        pgid = os.getpgid(p.pid)
    except ProcessLookupError:
        pgid = p.pid  # leader exited; its group may still have members
    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return

    def _reap():
        deadline = time.monotonic() + KILL_GRACE_SEC
        while time.monotonic() < deadline:
            try:
                os.killpg(pgid, 0)
            except ProcessLookupError:
                return
            p.poll()
            time.sleep(0.05)
        try:
            os.killpg(pgid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    threading.Thread(target=_reap, daemon=True).start()


Handler = Callable[[Job, JobContext], dict]


class JobManager:
    def __init__(self, handlers: dict[str, Handler], max_running: int = MAX_RUNNING):
        self.handlers = handlers
        self.max_running = max_running
        self.jobs: dict[str, Job] = {}
        self.queue: deque[Job] = deque()
        self.running = 0
        self.cond = threading.Condition()
        self._stop = False

    def submit(self, type_: str, input_: str, output: str, params: dict) -> Job:
        job = Job(id=str(uuid.uuid4()), type=type_, input=input_, output=output, params=params)
        with self.cond:
            self.jobs[job.id] = job
            self.queue.append(job)
            log.info("job %s queued type=%s", job.id, type_)
            self._dispatch()
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def cancel(self, job_id: str) -> Job | None:
        with self.cond:
            job = self.jobs.get(job_id)
            if job is None:
                return None
            if job.status == "queued":
                self.queue.remove(job)
                job.status = "cancelled"
                job.cancel_event.set()
                log.info("job %s cancelled while queued", job.id)
                return job
            if job.status != "running":
                return job
        with job.lock:
            job.cancel_event.set()
            procs = list(job.procs)
        for p in procs:
            kill_tree(p)
        log.info("job %s cancel requested", job.id)
        return job

    def shutdown(self, timeout: float = KILL_GRACE_SEC + 2) -> None:
        """Cancels every job and waits (bounded) for running ones to end, so their children are reaped."""
        with self.cond:
            self._stop = True
            ids = [j.id for j in self.jobs.values() if j.status in ("queued", "running")]
        for i in ids:
            self.cancel(i)
        with self.cond:
            self.cond.wait_for(lambda: self.running == 0, timeout)

    # ---- internals ----

    def _dispatch(self) -> None:
        """Starts queued jobs while a slot is free. Caller holds self.cond."""
        while not self._stop and self.queue and self.running < self.max_running:
            job = self.queue.popleft()
            job.status = "running"
            self.running += 1
            threading.Thread(target=self._run, args=(job,), name=f"job-{job.id}", daemon=True).start()

    def _run(self, job: Job) -> None:
        ctx = JobContext(job)
        log.info("job %s running type=%s", job.id, job.type)
        try:
            result = self.handlers[job.type](job, ctx)
            if job.cancel_event.is_set():
                raise JobCancelled()
            job.result = result
            job.progress = 1.0
            job.status = "done"
            log.info("job %s done", job.id)
        except JobCancelled:
            job.status = "cancelled"
            log.info("job %s cancelled", job.id)
        except JobError as e:
            if job.cancel_event.is_set():
                job.status = "cancelled"
            else:
                job.error = {"code": e.code, "message": e.message, **({"detail": e.detail} if e.detail else {})}
                job.status = "failed"
                log.warning("job %s failed code=%s", job.id, e.code)
        except Exception as e:  # noqa: BLE001 - any handler bug is a failed job, never a crashed worker
            if job.cancel_event.is_set():
                job.status = "cancelled"
            else:
                job.error = {"code": "INTERNAL", "message": f"{type(e).__name__} in {job.type}"}
                job.status = "failed"
                log.error("job %s failed with %s", job.id, type(e).__name__)
        finally:
            with job.lock:
                procs = list(job.procs)
            for p in procs:
                if p.poll() is None:
                    kill_tree(p)
            with self.cond:
                self.running -= 1
                self._dispatch()
                self.cond.notify_all()


def python_executable() -> str:
    return sys.executable
