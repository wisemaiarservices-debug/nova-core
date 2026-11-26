"""Strict verifier for short-lived gateway-to-private-API HMAC assertions.

This module authenticates only the internal assertion. Callers must still
consume its jti through the durable replay store and load tenant authorization
from D1 before returning tenant data.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping

MAX_TOKEN_LENGTH = 4096
MAX_ASSERTION_TTL_SECONDS = 120
CLOCK_SKEW_SECONDS = 15
MAX_ISSUER_AUDIENCE_LENGTH = 256
_KID_RE = re.compile(r"[A-Za-z0-9._-]{1,64}\Z")
_JTI_RE = re.compile(r"[A-Za-z0-9._~-]{16,128}\Z")
_SUBJECT_RE = re.compile(r"[^\x00-\x20\x7f]{1,200}\Z")
_PATH_RE = re.compile(
    r"/api/v1/tenants/[A-Za-z0-9._~-]{1,120}/"
    r"(?:sites|assets|sources|observations|audit-events)/"
    r"[A-Za-z0-9._~-]{1,160}\Z"
)
_SEGMENT_RE = re.compile(r"[A-Za-z0-9_-]+\Z")


class InternalAssertionError(ValueError):
    """An internal identity assertion is invalid or cannot be trusted."""


@dataclass(frozen=True)
class VerifiedInternalPrincipal:
    subject: str
    issuer: str
    audience: str
    issued_at: int
    expires_at: int
    jti: str
    method: str
    path: str
    key_id: str


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON member")
        result[key] = value
    return result


def _reject_constant(_value: str) -> None:
    raise ValueError("non-finite JSON number")


def _decode_segment(segment: str) -> bytes:
    if not isinstance(segment, str) or _SEGMENT_RE.fullmatch(segment) is None:
        raise ValueError("invalid base64url segment")
    padded = segment + "=" * (-len(segment) % 4)
    decoded = base64.urlsafe_b64decode(padded.encode("ascii"))
    canonical = base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=")
    if not hmac.compare_digest(canonical, segment):
        raise ValueError("non-canonical base64url segment")
    return decoded


def _decode_json(segment: str) -> dict[str, Any]:
    decoded = _decode_segment(segment)
    value = json.loads(
        decoded.decode("utf-8"),
        object_pairs_hook=_unique_object,
        parse_constant=_reject_constant,
    )
    if not isinstance(value, dict):
        raise ValueError("JSON object required")
    return value


def _is_integer(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def verify_internal_assertion(
    token: str,
    *,
    key_ring: Mapping[str, bytes],
    expected_issuer: str,
    expected_audience: str,
    request_method: str,
    request_path: str,
    now: int,
) -> VerifiedInternalPrincipal:
    """Verify a compact HS256 assertion bound to one exact read-only request.

    The function deliberately accepts a key ring supplied by trusted runtime
    configuration; it never reads secrets from requests or repository files.
    """
    if (
        not isinstance(token, str)
        or not token
        or len(token) > MAX_TOKEN_LENGTH
        or not isinstance(key_ring, Mapping)
        or not isinstance(expected_issuer, str)
        or not expected_issuer
        or len(expected_issuer) > MAX_ISSUER_AUDIENCE_LENGTH
        or not isinstance(expected_audience, str)
        or not expected_audience
        or len(expected_audience) > MAX_ISSUER_AUDIENCE_LENGTH
        or not isinstance(request_method, str)
        or not isinstance(request_path, str)
        or not _is_integer(now)
        or now <= 0
    ):
        raise InternalAssertionError("internal assertion rejected")

    segments = token.split(".")
    if len(segments) != 3 or any(not part for part in segments):
        raise InternalAssertionError("internal assertion rejected")

    try:
        header = _decode_json(segments[0])
        if set(header) != {"alg", "typ", "kid"}:
            raise ValueError("invalid protected header")
        if header["alg"] != "HS256" or header["typ"] != "NOVA-Internal-Request":
            raise ValueError("unsupported assertion algorithm or type")
        kid = header["kid"]
        if not isinstance(kid, str) or _KID_RE.fullmatch(kid) is None:
            raise ValueError("invalid key identifier")
        secret = key_ring.get(kid)
        if not isinstance(secret, bytes) or len(secret) < 32:
            raise ValueError("unknown or invalid signing key")

        supplied_signature = segments[2]
        signature_bytes = _decode_segment(supplied_signature)
        if len(signature_bytes) != hashlib.sha256().digest_size:
            raise ValueError("invalid signature length")
        signing_input = f"{segments[0]}.{segments[1]}".encode("ascii")
        expected_signature = base64.urlsafe_b64encode(
            hmac.new(secret, signing_input, hashlib.sha256).digest()
        ).decode("ascii").rstrip("=")
        if not hmac.compare_digest(expected_signature, supplied_signature):
            raise ValueError("signature mismatch")

        claims = _decode_json(segments[1])
        required = {"iss", "aud", "sub", "iat", "exp", "jti", "method", "path"}
        if set(claims) != required:
            raise ValueError("unexpected assertion claims")
        issuer, audience, subject = claims["iss"], claims["aud"], claims["sub"]
        issued_at, expires_at = claims["iat"], claims["exp"]
        jti, method, path = claims["jti"], claims["method"], claims["path"]

        if issuer != expected_issuer or audience != expected_audience:
            raise ValueError("wrong assertion issuer or audience")
        if not isinstance(subject, str) or _SUBJECT_RE.fullmatch(subject) is None:
            raise ValueError("invalid stable subject")
        if (
            not _is_integer(issued_at)
            or not _is_integer(expires_at)
            or issued_at <= 0
            or expires_at <= now
            or issued_at > now + CLOCK_SKEW_SECONDS
            or expires_at <= issued_at
            or expires_at - issued_at > MAX_ASSERTION_TTL_SECONDS
        ):
            raise ValueError("invalid assertion time envelope")
        if not isinstance(jti, str) or _JTI_RE.fullmatch(jti) is None:
            raise ValueError("invalid request identifier")
        if method != "GET" or request_method != "GET":
            raise ValueError("unsupported request method")
        if not isinstance(path, str) or _PATH_RE.fullmatch(path) is None:
            raise ValueError("invalid canonical request path")
        if request_path != path:
            raise ValueError("request path binding mismatch")

        return VerifiedInternalPrincipal(
            subject=subject,
            issuer=issuer,
            audience=audience,
            issued_at=issued_at,
            expires_at=expires_at,
            jti=jti,
            method=method,
            path=path,
            key_id=kid,
        )
    except InternalAssertionError:
        raise
    except Exception as exc:
        # Do not reveal signature, key, claim, or parser details to the caller.
        raise InternalAssertionError("internal assertion rejected") from exc
