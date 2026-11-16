"""SQLite/D1 contract tests for measurement-quality evidence lifecycle guards.

These tests deliberately perform the evidence lookup first, revoke one dependency,
then attempt the assessment INSERT. The INSERT is the database boundary that must
reject a stale passed/failed result even if an application read happened earlier.
"""
import sqlite3
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"
MIGRATION_NAMES = (
    "0001_initial.sql",
    "0002_tenant_isolation.sql",
    "0003_internal_request_nonces.sql",
    "0004_tenant_ownership_immutability.sql",
    "0005_tenant_site_configuration_history.sql",
    "0006_site_configuration_idempotency.sql",
    "0007_water_quality_criteria_registry.sql",
    "0008_water_quality_criteria_reviewer_events.sql",
    "0010_observation_verification_workflow.sql",
    "0011_laboratory_report_evidence.sql",
    "0012_sensor_calibration_provenance.sql",
    "0013_sensor_calibration_verification.sql",
    "0014_sensor_source_identity.sql",
    "0015_measurement_quality_engine.sql",
    "0016_asset_tenant_site_composite_key.sql",
    "0017_sensor_calibration_event_composite_key.sql",
)


def database():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for name in MIGRATION_NAMES:
        db.executescript((MIGRATIONS / name).read_text(encoding="utf-8"))

    db.execute("INSERT INTO tenants (id, display_name, status) VALUES ('tenant-a', 'Tenant A', 'active')")
    db.execute("INSERT INTO sites (id, tenant_id, name, status) VALUES ('site-a', 'tenant-a', 'Site A', 'active')")
    db.execute("""INSERT INTO assets
        (id, site_id, tenant_id, name, asset_type, status)
        VALUES ('asset-a', 'site-a', 'tenant-a', 'Sensor Asset', 'sensor', 'active')""")
    db.execute("""INSERT INTO sources
        (id, site_id, tenant_id, module, provider, source_type, display_name, verification_status)
        VALUES ('source-a', 'site-a', 'tenant-a', 'neoagro', 'declared-provider',
                'sensor', 'Sensor Source', 'verified')""")
    db.execute("""INSERT INTO observations
        (id, site_id, tenant_id, asset_id, source_id, module, metric, value, unit,
         observed_at, idempotency_key, verification_status, provenance_json, quality_flags_json)
        VALUES ('obs-a', 'site-a', 'tenant-a', 'asset-a', 'source-a', 'neoagro',
                'ec', 1.5, 'dS/m', '2026-05-10T10:00:00Z', 'obs-key-a',
                'unverified', '{}', '[]')""")
    db.execute("""INSERT INTO audit_events
        (id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, details_json)
        VALUES ('audit-a', 'tenant-a', 'service', 'ingestion-service', 'observation.accepted',
                'observation', 'obs-a', '{}')""")

    # The same independent measurement reviewer can review the observation and policy.
    db.execute("""INSERT INTO observation_reviewers
        (tenant_id, site_id, reviewer_subject, reviewer_role, status,
         assigned_by_subject, assignment_evidence_ref)
        VALUES ('tenant-a', 'site-a', 'reviewer-a', 'measurement_reviewer',
                'active', 'owner-a', 'appointment:measurement')""")
    db.execute("""INSERT INTO observation_reviewer_events
        (id, tenant_id, site_id, reviewer_subject, reviewer_role, event_type,
         actor_subject, evidence_ref, request_id)
        VALUES ('reviewer-event-a', 'tenant-a', 'site-a', 'reviewer-a',
                'measurement_reviewer', 'assigned', 'owner-a',
                'appointment:measurement', 'reviewer-request-a')""")
    db.execute("""INSERT INTO observation_verification_events
        (id, tenant_id, site_id, observation_id, reviewer_subject, reviewer_role,
         event_type, evidence_ref, request_id)
        VALUES ('obs-verified-a', 'tenant-a', 'site-a', 'obs-a', 'reviewer-a',
                'measurement_reviewer', 'verified', 'inspection:observation-a', 'obs-review-a')""")
    db.execute("UPDATE observations SET verification_status='verified' WHERE id='obs-a'")

    # Explicit, independent sensor-source identity mapping.
    db.execute("""INSERT INTO sensor_source_mapping_reviewers
        (tenant_id, site_id, reviewer_subject, status, assigned_by_subject, evidence_ref)
        VALUES ('tenant-a', 'site-a', 'mapping-reviewer-a', 'active',
                'owner-a', 'appointment:mapping')""")
    db.execute("""INSERT INTO sensor_source_identity_mappings
        (id, tenant_id, site_id, asset_id, source_id, sensor_id, parameter, unit,
         effective_from, mapping_method, evidence_ref, registered_by_subject)
        VALUES ('mapping-a', 'tenant-a', 'site-a', 'asset-a', 'source-a',
                'sensor-a', 'ec', 'dS/m', '2026-01-01T00:00:00Z',
                'declared-wiring-review', 'evidence:mapping', 'registrant-a')""")
    db.execute("""INSERT INTO sensor_source_mapping_events
        (id, tenant_id, site_id, asset_id, source_id, mapping_id, reviewer_subject,
         event_type, evidence_ref, request_id)
        VALUES ('mapping-verified-a', 'tenant-a', 'site-a', 'asset-a', 'source-a',
                'mapping-a', 'mapping-reviewer-a', 'verified',
                'evidence:mapping-review', 'mapping-review-a')""")

    # Independently reviewed calibration with an effective interval covering the observation.
    db.execute("""INSERT INTO sensor_calibration_reviewers
        (tenant_id, site_id, reviewer_subject, reviewer_role, status,
         assigned_by_subject, assignment_evidence_ref)
        VALUES ('tenant-a', 'site-a', 'cal-reviewer-a', 'calibration_reviewer',
                'active', 'owner-a', 'appointment:calibration')""")
    db.execute("""INSERT INTO sensor_calibrations
        (id, tenant_id, site_id, asset_id, sensor_id, parameter, unit,
         calibration_method, calibrated_at, valid_until, reference_value,
         as_found_value, as_left_value, uncertainty, registered_by_subject)
        VALUES ('calibration-a', 'tenant-a', 'site-a', 'asset-a', 'sensor-a',
                'ec', 'dS/m', 'reference-solution', '2026-01-01T00:00:00Z',
                '2026-12-31T23:59:59Z', 1.5, 1.51, 1.5, 0.01, 'cal-registrant-a')""")
    db.execute("""INSERT INTO sensor_calibration_events
        (id, calibration_id, tenant_id, site_id, event_type, actor_subject, request_id)
        VALUES ('cal-registration-a', 'calibration-a', 'tenant-a', 'site-a',
                'registered', 'cal-registrant-a', 'cal-registration-request-a')""")
    db.execute("""INSERT INTO sensor_calibration_verification_events
        (id, tenant_id, site_id, asset_id, calibration_id, reviewer_subject,
         reviewer_role, event_type, evidence_ref, request_id)
        VALUES ('cal-verified-a', 'tenant-a', 'site-a', 'asset-a', 'calibration-a',
                'cal-reviewer-a', 'calibration_reviewer', 'verified',
                'evidence:calibration-review', 'cal-review-a')""")

    # Explicit customer policy, independently verified by a measurement reviewer.
    db.execute("""INSERT INTO measurement_quality_policies
        (id, tenant_id, site_id, asset_id, sensor_id, parameter, unit, version,
         minimum_value, maximum_value, effective_from, method, evidence_ref, registered_by_subject)
        VALUES ('policy-a', 'tenant-a', 'site-a', 'asset-a', 'sensor-a', 'ec',
                'dS/m', '1', 0.5, 2.0, '2026-01-01T00:00:00Z',
                'declared-operating-range', 'evidence:policy', 'policy-registrant-a')""")
    db.execute("""INSERT INTO measurement_quality_policy_events
        (id, tenant_id, site_id, asset_id, policy_id, reviewer_subject,
         event_type, evidence_ref, request_id)
        VALUES ('policy-verified-a', 'tenant-a', 'site-a', 'asset-a', 'policy-a',
                'reviewer-a', 'verified', 'evidence:policy-review', 'policy-review-a')""")
    return db


def assessment_insert(db, request_id):
    db.execute("""INSERT INTO measurement_quality_assessments
        (id, tenant_id, site_id, observation_id, mapping_id, calibration_id, policy_id,
         status, reason_code, observed_value, unit, method_version, request_id)
        VALUES (?, 'tenant-a', 'site-a', 'obs-a', 'mapping-a', 'calibration-a', 'policy-a',
                'passed', 'within_declared_policy', 1.5, 'dS/m', '1.0.0', ?)""",
        ("assessment-" + request_id, request_id))


def revoke_mapping(db):
    db.execute("""INSERT INTO sensor_source_mapping_events
        (id, tenant_id, site_id, asset_id, source_id, mapping_id, reviewer_subject,
         event_type, evidence_ref, reason, request_id)
        VALUES ('mapping-revoked-a', 'tenant-a', 'site-a', 'asset-a', 'source-a',
                'mapping-a', 'mapping-reviewer-a', 'revoked',
                'evidence:mapping-revocation', 'mapping withdrawn', 'mapping-revoke-a')""")


def revoke_calibration(db):
    db.execute("""INSERT INTO sensor_calibration_verification_events
        (id, tenant_id, site_id, asset_id, calibration_id, reviewer_subject,
         reviewer_role, event_type, evidence_ref, reason, request_id)
        VALUES ('cal-revoked-a', 'tenant-a', 'site-a', 'asset-a', 'calibration-a',
                'cal-reviewer-a', 'calibration_reviewer', 'revoked',
                'evidence:calibration-revocation', 'certificate withdrawn', 'cal-revoke-a')""")


def revoke_policy(db):
    db.execute("""INSERT INTO measurement_quality_policy_events
        (id, tenant_id, site_id, asset_id, policy_id, reviewer_subject,
         event_type, evidence_ref, reason, request_id)
        VALUES ('policy-revoked-a', 'tenant-a', 'site-a', 'asset-a', 'policy-a',
                'reviewer-a', 'revoked', 'evidence:policy-revocation',
                'policy withdrawn', 'policy-revoke-a')""")


def test_valid_exact_scope_evidence_chain_allows_passed_assessment():
    db = database()
    assessment_insert(db, "baseline")
    row = db.execute(
        "SELECT status, reason_code FROM measurement_quality_assessments WHERE request_id='baseline'"
    ).fetchone()
    assert row == ("passed", "within_declared_policy")


@pytest.mark.parametrize(
    "revoke",
    [
        lambda db: db.execute("UPDATE sources SET verification_status='disabled' WHERE id='source-a'"),
        revoke_mapping,
        revoke_calibration,
        revoke_policy,
    ],
    ids=["source-disabled", "mapping-revoked", "calibration-revoked", "policy-revoked"],
)
def test_database_rejects_stale_passed_assessment_after_evidence_revocation(revoke):
    db = database()

    # Model the service's earlier successful lookup, then mutate the evidence chain.
    # The database must independently re-check current lifecycle state at INSERT.
    evidence_snapshot = db.execute(
        """SELECT o.id, m.id, c.id, p.id
           FROM observations o
           JOIN sensor_source_identity_mappings m ON m.id='mapping-a'
           JOIN sensor_calibrations c ON c.id='calibration-a'
           JOIN measurement_quality_policies p ON p.id='policy-a'
           WHERE o.id='obs-a' AND o.verification_status='verified'"""
    ).fetchone()
    assert evidence_snapshot == ("obs-a", "mapping-a", "calibration-a", "policy-a")

    revoke(db)

    with pytest.raises(sqlite3.IntegrityError, match="quality result requires verified exact-scope"):
        assessment_insert(db, "stale-after-revocation")

    assert db.execute(
        "SELECT COUNT(*) FROM measurement_quality_assessments WHERE request_id='stale-after-revocation'"
    ).fetchone() == (0,)
