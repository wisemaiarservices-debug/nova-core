"""Private tenant API: authentication, replay prevention, authorization, then scoped read.

This ASGI app is intentionally separate from the public research/demo API.
It is inert until deployed behind Cloudflare Access and reached only through a
private Service Binding. No tenant write routes are defined.
"""
from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any

from fastapi import FastAPI, HTTPException, Request

try:
    from .services.internal_assertion import (
        InternalAssertionError,
        verify_internal_assertion,
    )
    from .services.tenant_request_replay import (
        RequestReplayStorageError,
        consume_request_nonce,
    )
    from .services.tenant_authorization_storage import TenantAuthorizationStorageError
    from .services.tenant_scoped_repository import read_authorized_tenant_resource
except ImportError:
    from services.internal_assertion import (
        InternalAssertionError,
        verify_internal_assertion,
    )
    from services.tenant_request_replay import (
        RequestReplayStorageError,
        consume_request_nonce,
    )
    from services.tenant_authorization_storage import TenantAuthorizationStorageError
    from services.tenant_scoped_repository import read_authorized_tenant_resource


RESOURCE_TYPES = {
    "sites": "site",
    "assets": "asset",
    "sources": "source",
    "observations": "observation",
    "audit-events": "audit_event",
}


def _binding(env: Any, name: str) -> Any:
    if isinstance(env, Mapping):
        return env.get(name)
    return getattr(env, name, None)


def _one_bearer_token(authorization_values: list[bytes]) -> str:
    if len(authorization_values) != 1:
        raise InternalAssertionError("internal assertion rejected")
    try:
        value = authorization_values[0].decode("ascii")
    except (AttributeError, UnicodeDecodeError) as exc:
        raise InternalAssertionError("internal assertion rejected") from exc
    scheme, separator, token = value.partition(" ")
    if (
        scheme.lower() != "bearer"
        or separator != " "
        or not token
        or " " in token
        or "," in token
    ):
        raise InternalAssertionError("internal assertion rejected")
    return token


async def resolve_private_tenant_read(
    *,
    method: str,
    raw_path: str,
    authorization_values: list[bytes],
    env: Any,
    tenant_id: str,
    resource_collection: str,
    resource_id: str,
    now: int | None = None,
) -> dict[str, Any] | None:
    """Compose assertion verification → nonce consumption → D1 authorization → read."""
    resource_type = RESOURCE_TYPES.get(resource_collection)
    expected_path = (
        f"/api/v1/tenants/{tenant_id}/{resource_collection}/{resource_id}"
    )
    if (
        resource_type is None
        or method != "GET"
        or raw_path != expected_path
        or not isinstance(tenant_id, str)
        or not isinstance(resource_id, str)
    ):
        raise InternalAssertionError("internal assertion rejected")

    token = _one_bearer_token(authorization_values)
    key_id = _binding(env, "NOVA_INTERNAL_KEY_ID")
    secret = _binding(env, "NOVA_INTERNAL_HMAC_KEY")
    issuer = _binding(env, "NOVA_INTERNAL_ISSUER")
    audience = _binding(env, "NOVA_INTERNAL_AUDIENCE")
    database = _binding(env, "DB")
    if database is None:
        raise RequestReplayStorageError("request replay storage is unavailable")
    if not isinstance(key_id, str) or not isinstance(secret, str):
        raise InternalAssertionError("internal assertion rejected")

    current_time = int(time.time()) if now is None else now
    principal = verify_internal_assertion(
        token,
        key_ring={key_id: secret.encode("utf-8")},
        expected_issuer=issuer,
        expected_audience=audience,
        request_method=method,
        request_path=raw_path,
        now=current_time,
    )

    # Consume the jti before any tenant membership/grant/resource lookup.
    # A denied or missing resource still consumes the assertion, preventing
    # the same short-lived signed request from being replayed later.
    consumed = await consume_request_nonce(
        database,
        jti=principal.jti,
        issued_at=principal.issued_at,
        expires_at=principal.expires_at,
        now=current_time,
    )
    if not consumed:
        return None

    return await read_authorized_tenant_resource(
        database,
        principal_subject=principal.subject,
        tenant_id=tenant_id,
        resource_type=resource_type,
        resource_id=resource_id,
    )


app = FastAPI(title="NOVA Core Private Tenant API", version="0.1.0")


@app.get("/api/v1/tenants/{tenant_id}/{resource_collection}/{resource_id}")
async def read_tenant_resource(
    request: Request,
    tenant_id: str,
    resource_collection: str,
    resource_id: str,
) -> dict[str, Any]:
    """Return one tenant resource after all internal trust and D1 gates pass."""
    raw_path = request.scope.get("raw_path")
    if not isinstance(raw_path, bytes):
        raise HTTPException(status_code=401, detail="unauthorized")
    try:
        canonical_path = raw_path.decode("ascii")
    except UnicodeDecodeError as exc:
        raise HTTPException(status_code=401, detail="unauthorized") from exc

    raw_headers = request.scope.get("headers", [])
    authorization_values = [
        value for key, value in raw_headers
        if isinstance(key, bytes) and key.lower() == b"authorization"
    ]
    try:
        result = await resolve_private_tenant_read(
            method=request.method,
            raw_path=canonical_path,
            authorization_values=authorization_values,
            env=request.scope.get("env"),
            tenant_id=tenant_id,
            resource_collection=resource_collection,
            resource_id=resource_id,
        )
    except InternalAssertionError as exc:
        raise HTTPException(status_code=401, detail="unauthorized") from exc
    except (RequestReplayStorageError, TenantAuthorizationStorageError) as exc:
        raise HTTPException(status_code=503, detail="private tenant service unavailable") from exc

    if result is None:
        # Replay, authorization denial and missing resources are indistinguishable.
        raise HTTPException(status_code=404, detail="not found")
    return result
