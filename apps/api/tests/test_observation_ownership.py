import pytest

from apps.api.services.observation_contract import validate_observation_payload
from apps.api.services.observation_ownership import (
    AssetOwnershipRecord,
    OwnershipDenied,
    SiteOwnershipRecord,
    SourceOwnershipRecord,
    validate_observation_ownership,
)


def submission(asset_id="asset-01"):
    return validate_observation_payload({
        "site_id": "site-01",
        "asset_id": asset_id,
        "source_id": "source-01",
        "module": "neoagro",
        "metric": "soil.moisture",
        "value": 31,
        "unit": "%",
        "observed_at": "2026-11-10T10:00:00Z",
        "idempotency_key": "obs-001",
        "provenance": {"provider": "field-gateway", "acquisition_method": "sensor"},
    })


def valid_records():
    return {
        "site": SiteOwnershipRecord("site-01", "active"),
        "source": SourceOwnershipRecord("source-01", "neoagro", "site-01", "unverified"),
        "asset": AssetOwnershipRecord("asset-01", "site-01", "active"),
    }


def test_allows_matching_active_site_source_asset():
    records = valid_records()
    assert validate_observation_ownership(submission(), **records) is None


def test_allows_global_source_but_keeps_it_unverified():
    records = valid_records()
    records["source"] = SourceOwnershipRecord("source-01", "neoagro", None, "unverified")
    assert validate_observation_ownership(submission(), **records) is None


@pytest.mark.parametrize("site", [
    None,
    SiteOwnershipRecord("other-site", "active"),
    SiteOwnershipRecord("site-01", "inactive"),
    SiteOwnershipRecord("site-01", "unconfigured"),
])
def test_rejects_missing_or_inactive_site(site):
    records = valid_records()
    records["site"] = site
    with pytest.raises(OwnershipDenied):
        validate_observation_ownership(submission(), **records)


@pytest.mark.parametrize("source", [
    None,
    SourceOwnershipRecord("other-source", "neoagro", "site-01", "unverified"),
    SourceOwnershipRecord("source-01", "neogrid", "site-01", "unverified"),
    SourceOwnershipRecord("source-01", "neoagro", "other-site", "unverified"),
    SourceOwnershipRecord("source-01", "neoagro", "site-01", "disabled"),
])
def test_rejects_wrong_or_disabled_source(source):
    records = valid_records()
    records["source"] = source
    with pytest.raises(OwnershipDenied):
        validate_observation_ownership(submission(), **records)


@pytest.mark.parametrize("asset", [
    None,
    AssetOwnershipRecord("other-asset", "site-01", "active"),
    AssetOwnershipRecord("asset-01", "other-site", "active"),
    AssetOwnershipRecord("asset-01", "site-01", "retired"),
])
def test_rejects_missing_or_non_owned_asset(asset):
    records = valid_records()
    records["asset"] = asset
    with pytest.raises(OwnershipDenied):
        validate_observation_ownership(submission(), **records)


def test_site_level_observation_does_not_accept_an_asset_record():
    records = valid_records()
    records["asset"] = None
    assert validate_observation_ownership(submission(asset_id=None), **records) is None


def test_site_level_observation_rejects_unexpected_asset_record():
    with pytest.raises(OwnershipDenied):
        validate_observation_ownership(submission(asset_id=None), **valid_records())
