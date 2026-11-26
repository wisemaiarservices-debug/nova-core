"""Pure authorization policy for already-verified server service identities.

This module does not parse headers or validate Cloudflare Access JWTs. Only the
future authentication adapter may construct VerifiedServicePrincipal instances.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Mapping

from .observation_contract import ObservationSubmission


@dataclass(frozen=True)
class VerifiedServicePrincipal:
    """Identity claims emitted by a successful, signature-verified auth adapter."""

    service_id: str
    issuer: str
    audience: str
    token_id: str | None = None


@dataclass(frozen=True)
class ServiceGrant:
    """Exact module-to-source grants; wildcards are intentionally unsupported."""

    module_sources: Mapping[str, frozenset[str]]


class AuthorizationDenied(PermissionError):
    """Raised when a verified service lacks the requested observation grant."""


def parse_service_grants(raw: str) -> dict[str, ServiceGrant]:
    """Parse server-side JSON allowlist; never accepts wildcard module/source grants.

    Expected shape:
    {
      "neoagro-ingestor": {
        "neoagro": ["source-weather-01", "source-soil-01"]
      }
    }
    """
    try:
        payload = json.loads(raw)
    except (TypeError, json.JSONDecodeError) as exc:
        raise ValueError("service grant configuration must be valid JSON") from exc
    if not isinstance(payload, dict) or not payload:
        raise ValueError("service grant configuration must be a non-empty object")

    grants: dict[str, ServiceGrant] = {}
    for service_id, modules in payload.items():
        if not isinstance(service_id, str) or not service_id.strip():
            raise ValueError("service identifiers must be non-empty strings")
        if not isinstance(modules, dict) or not modules:
            raise ValueError(f"service {service_id!r} must define module grants")
        normalized: dict[str, frozenset[str]] = {}
        for module, sources in modules.items():
            if module not in {"nova-core", "neoagro", "neogrid", "neocell"}:
                raise ValueError(f"unsupported module grant: {module!r}")
            if (
                not isinstance(sources, list)
                or not sources
                or any(not isinstance(source, str) or not source.strip() or source == "*" for source in sources)
                or len(sources) != len(set(sources))
            ):
                raise ValueError(f"module {module!r} requires unique, exact source IDs")
            normalized[module] = frozenset(sources)
        grants[service_id] = ServiceGrant(module_sources=normalized)
    return grants


def authorize_observation(
    principal: VerifiedServicePrincipal,
    submission: ObservationSubmission,
    grants: Mapping[str, ServiceGrant],
) -> None:
    """Authorize exact identity + module + source tuple; deny by default."""
    if not isinstance(principal, VerifiedServicePrincipal):
        raise AuthorizationDenied("verified service identity required")
    if not principal.service_id or not principal.issuer or not principal.audience:
        raise AuthorizationDenied("verified service identity is incomplete")

    grant = grants.get(principal.service_id)
    if grant is None:
        raise AuthorizationDenied("service is not authorized")
    allowed_sources = grant.module_sources.get(submission.module, frozenset())
    if submission.source_id not in allowed_sources:
        raise AuthorizationDenied("service is not authorized for this module and source")
