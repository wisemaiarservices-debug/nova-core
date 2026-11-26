"""Pure ownership checks for records resolved by a trusted storage adapter.

This module performs no database access. Callers must resolve records from D1
using parameterized queries and pass the resulting server-owned records here.
"""
from __future__ import annotations

from dataclasses import dataclass

from .observation_contract import ObservationSubmission


class OwnershipDenied(PermissionError):
    """The observation does not match active site/source/asset ownership."""


@dataclass(frozen=True)
class SiteOwnershipRecord:
    site_id: str
    status: str


@dataclass(frozen=True)
class SourceOwnershipRecord:
    source_id: str
    module: str
    site_id: str | None
    verification_status: str


@dataclass(frozen=True)
class AssetOwnershipRecord:
    asset_id: str
    site_id: str
    status: str


def validate_observation_ownership(
    submission: ObservationSubmission,
    *,
    site: SiteOwnershipRecord | None,
    source: SourceOwnershipRecord | None,
    asset: AssetOwnershipRecord | None,
) -> None:
    """Require an active site and exact source/module/site and optional asset match.

    Unverified sources may submit observations, but those observations remain
    unverified. Disabled sources and non-active sites/assets are denied.
    """
    if site is None or site.site_id != submission.site_id or site.status != "active":
        raise OwnershipDenied("active site ownership could not be established")

    if (
        source is None
        or source.source_id != submission.source_id
        or source.module != submission.module
        or source.site_id not in (None, submission.site_id)
        or source.verification_status == "disabled"
    ):
        raise OwnershipDenied("source ownership could not be established")

    if submission.asset_id is None:
        if asset is not None:
            raise OwnershipDenied("unexpected asset record for site-level observation")
        return

    if (
        asset is None
        or asset.asset_id != submission.asset_id
        or asset.site_id != submission.site_id
        or asset.status != "active"
    ):
        raise OwnershipDenied("active asset ownership could not be established")
