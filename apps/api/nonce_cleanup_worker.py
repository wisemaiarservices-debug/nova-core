"""Private scheduled maintenance Worker for bounded D1 nonce cleanup.

This Worker has no HTTP handler, public route, Access surface, or Service Binding.
Its only intended binding is the D1 database containing internal_request_nonces.
"""
from __future__ import annotations

import math
from typing import Any

try:
    from workers import WorkerEntrypoint
except ModuleNotFoundError as exc:
    # The CPython test runner has no Workers runtime bridge (js module). The
    # fallback keeps policy helpers testable; the deployment dry-run still
    # packages the real Workers runtime entrypoint.
    if exc.name != "js":
        raise

    class WorkerEntrypoint:
        pass

try:
    from .services.tenant_request_replay import MAX_CLEANUP_BATCH, RequestReplayStorageError, cleanup_expired_request_nonces
except ImportError:
    from services.tenant_request_replay import MAX_CLEANUP_BATCH, RequestReplayStorageError, cleanup_expired_request_nonces


def _scheduled_epoch_seconds(scheduled_time_ms: Any) -> int:
    """Convert platform scheduled epoch milliseconds to safe Unix seconds.

    JavaScript numbers can arrive through the Python Workers bridge as floats.
    Accept only finite integral values so this representation does not weaken
    timestamp validation or silently truncate fractional milliseconds.
    """
    if isinstance(scheduled_time_ms, bool) or not isinstance(scheduled_time_ms, (int, float)):
        raise ValueError("invalid scheduled invocation time")
    if isinstance(scheduled_time_ms, float):
        if not math.isfinite(scheduled_time_ms) or not scheduled_time_ms.is_integer():
            raise ValueError("invalid scheduled invocation time")
    if scheduled_time_ms <= 0:
        raise ValueError("invalid scheduled invocation time")
    return int(scheduled_time_ms) // 1000


async def run_nonce_cleanup(database: Any, *, scheduled_time_ms: Any) -> int:
    """Delete at most one bounded batch using the scheduled event timestamp."""
    if database is None:
        raise RequestReplayStorageError("request replay cleanup is unavailable")
    now = _scheduled_epoch_seconds(scheduled_time_ms)
    return await cleanup_expired_request_nonces(database, now=now, limit=MAX_CLEANUP_BATCH)


class Default(WorkerEntrypoint):
    """Cloudflare Python Worker scheduled entrypoint."""

    async def scheduled(self, controller, env, ctx):
        # Python WorkerEntrypoint exposes configured bindings on self.env,
        # matching Cloudflare's documented D1 access pattern. Keep the
        # scheduled env argument as a compatibility fallback for runtimes
        # that expose the module-style handler environment there.
        try:
            database = self.env.TENANT_DB
        except AttributeError:
            try:
                database = env.TENANT_DB
            except AttributeError:
                database = None
        try:
            await run_nonce_cleanup(database, scheduled_time_ms=controller.scheduledTime)
        except Exception as exc:
            # Keep diagnostics useful without emitting assertion or tenant data.
            detail = str(exc) if isinstance(exc, RequestReplayStorageError) else type(exc).__name__
            print(f"nonce cleanup scheduled handler failed: {detail}")
            raise
