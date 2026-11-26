"""Durable, fail-closed replay protection for gateway-to-tenant-API assertions.

The caller must verify signature, issuer, audience, method/path binding and
assertion timestamps before calling consume_request_nonce. D1's unique primary
key and one INSERT statement provide the atomic one-time claim; isolate-local
caches are deliberately not used.
"""
from __future__ import annotations

import re
from typing import Any

MAX_ASSERTION_TTL_SECONDS = 120
CLOCK_SKEW_SECONDS = 15
NONCE_RETENTION_SECONDS = 86_400
MAX_CLEANUP_BATCH = 500

NONCE_INSERT_SQL = """
INSERT INTO internal_request_nonces (jti, expires_at, retained_until, consumed_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(jti) DO NOTHING
RETURNING jti
"""

NONCE_CLEANUP_SQL = """
DELETE FROM internal_request_nonces
WHERE jti IN (
    SELECT jti
    FROM internal_request_nonces
    WHERE retained_until <= ?
    ORDER BY retained_until ASC, jti ASC
    LIMIT ?
)
RETURNING jti
"""


class RequestReplayStorageError(RuntimeError):
    """Durable replay protection could not be completed safely."""


def _valid_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _rows(result: Any, *, maximum: int) -> list[dict[str, Any]]:
    success = getattr(result, "success", None)
    if success is None and isinstance(result, dict):
        success = result.get("success")
    if success is False:
        raise RequestReplayStorageError("request replay storage is unavailable")
    rows = getattr(result, "results", None)
    if rows is None and isinstance(result, dict):
        rows = result.get("results")
    if not isinstance(rows, list) or len(rows) > maximum:
        raise RequestReplayStorageError("request replay storage returned an invalid result")
    if any(not isinstance(row, dict) for row in rows):
        raise RequestReplayStorageError("request replay storage returned an invalid result")
    return rows


async def consume_request_nonce(
    database: Any,
    *,
    jti: str,
    issued_at: int,
    expires_at: int,
    now: int,
) -> bool:
    """Atomically consume one verified assertion ID; return False on replay.

    This function validates the assertion's time envelope but does not verify
    its signature or claims. The caller must do that first. Expired IDs remain
    reserved for one day after assertion expiry.
    """
    if (
        database is None
        or not isinstance(jti, str)
        or not 16 <= len(jti) <= 128
        or jti != jti.strip()
        or re.fullmatch(r"[A-Za-z0-9._~-]{16,128}", jti) is None
        or not all(_valid_integer(value) for value in (issued_at, expires_at, now))
        or issued_at <= 0
        or expires_at <= now
        or issued_at > now + CLOCK_SKEW_SECONDS
        or expires_at <= issued_at
        or expires_at - issued_at > MAX_ASSERTION_TTL_SECONDS
    ):
        return False

    try:
        result = await database.prepare(NONCE_INSERT_SQL).bind(
            jti,
            expires_at,
            expires_at + NONCE_RETENTION_SECONDS,
            now,
        ).run()
        rows = _rows(result, maximum=1)
        if not rows:
            return False
        if len(rows) != 1 or rows[0].get("jti") != jti:
            raise RequestReplayStorageError("request replay storage returned an invalid claim")
        return True
    except RequestReplayStorageError:
        raise
    except Exception as exc:
        raise RequestReplayStorageError("request replay storage is unavailable") from exc


async def cleanup_expired_request_nonces(
    database: Any,
    *,
    now: int,
    limit: int = MAX_CLEANUP_BATCH,
) -> int:
    """Delete a bounded batch of IDs whose replay-retention window has ended."""
    if (
        database is None
        or not _valid_integer(now)
        or now <= 0
        or not _valid_integer(limit)
        or not 1 <= limit <= MAX_CLEANUP_BATCH
    ):
        raise ValueError("invalid request replay cleanup bounds")
    try:
        result = await database.prepare(NONCE_CLEANUP_SQL).bind(now, limit).run()
        rows = _rows(result, maximum=limit)
        if any(not isinstance(row.get("jti"), str) for row in rows):
            raise RequestReplayStorageError("request replay storage returned an invalid cleanup result")
        return len(rows)
    except RequestReplayStorageError:
        raise
    except Exception as exc:
        raise RequestReplayStorageError("request replay cleanup is unavailable") from exc
