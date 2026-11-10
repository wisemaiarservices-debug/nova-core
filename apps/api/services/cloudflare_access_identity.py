"""Claim adapter for Cloudflare Access service-token JWTs.

IMPORTANT: this function validates claims only. The caller MUST first verify the
JWT RS256 signature against the Access JWKS. Never pass decoded, unverified
JWT payloads to this function.
"""
from __future__ import annotations

import time
from collections.abc import Mapping
from typing import Any

from .service_authorization import VerifiedServicePrincipal


class AccessIdentityError(ValueError):
    """Cloudflare Access claims do not represent the expected service token."""


def principal_from_verified_access_claims(
    claims: Mapping[str, Any],
    *,
    expected_issuer: str,
    expected_audience: str,
    now_epoch: int | None = None,
) -> VerifiedServicePrincipal:
    """Convert claims from a cryptographically verified JWT into a principal.

    Signature, algorithm (RS256), key ID, and JWKS validation are intentionally
    outside this pure adapter and are mandatory before calling it.
    """
    now = int(time.time()) if now_epoch is None else now_epoch
    if claims.get("iss") != expected_issuer:
        raise AccessIdentityError("unexpected Access token issuer")

    audience = claims.get("aud")
    audiences = [audience] if isinstance(audience, str) else audience
    if not isinstance(audiences, list) or expected_audience not in audiences:
        raise AccessIdentityError("unexpected Access token audience")

    if claims.get("type") != "app" or claims.get("service_token_status") is not True:
        raise AccessIdentityError("an authenticated Access service token is required")

    service_id = claims.get("common_name")
    if not isinstance(service_id, str) or not service_id.strip():
        raise AccessIdentityError("Access service token identity is missing")

    expires_at = claims.get("exp")
    issued_at = claims.get("iat")
    if not isinstance(expires_at, int) or isinstance(expires_at, bool) or expires_at <= now:
        raise AccessIdentityError("Access service token is expired or has invalid expiry")
    if not isinstance(issued_at, int) or isinstance(issued_at, bool) or issued_at > now + 300:
        raise AccessIdentityError("Access service token has invalid issue time")

    token_id = claims.get("jti")
    if token_id is not None and not isinstance(token_id, str):
        raise AccessIdentityError("Access token identifier is invalid")

    return VerifiedServicePrincipal(
        service_id=service_id,
        issuer=expected_issuer,
        audience=expected_audience,
        token_id=token_id,
    )
