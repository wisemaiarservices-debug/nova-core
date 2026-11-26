"""Private scheduled maintenance Worker for bounded D1 nonce cleanup.

This Worker has no HTTP handler, public route, Access surface, or Service Binding.
Its only intended binding is the D1 database containing internal_request_nonces.
"""
from __future__ import annotations

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
    """Convert platform scheduled epoch milliseconds to safe Unix seconds."""
    if not isinstance(scheduled_time_ms, int) or isinstance(scheduled_time_ms, bool) or scheduled_time_ms <= 0:
        raise ValueError("invalid scheduled invocation time")
    return scheduled_time_ms // 1000


async def run_nonce_cleanup(database: Any, *, scheduled_time_ms: Any) -> int:
    """Delete at most one bounded batch using the scheduled event timestamp."""
    if database is None:
        raise RequestReplayStorageError("request replay cleanup is unavailable")
    now = _scheduled_epoch_seconds(scheduled_time_ms)
    return await cleanup_expired_request_nonces(database, now=now, limit=MAX_CLEANUP_BATCH)


class Default(WorkerEntrypoint):
    """Cloudflare Python Worker scheduled entrypoint."""

    async def scheduled(self, controller, env, ctx):
        database = getattr(env, "TENANT_DB", None)
        await run_nonce_cleanup(database, scheduled_time_ms=getattr(controller, "scheduledTime", None))
