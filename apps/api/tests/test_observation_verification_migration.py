"""SQLite contract tests for tenant-scoped observation verification migration."""
import hashlib
import sqlite3
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


def database():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for name in (
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
        "0012_sensor_calibration_quality.sql",
    ):
        db.executescript((MIGRATIONS / name).read_text(encoding="utf-8"))
    db.execute("INSERT INTO tenants (id, display_name) VALUES ('tenant-a', 'Tenant A')")
    db.execute("INSERT INTO tenant_memberships (id, tenant_id, subject, role, status) VALUES ('membership-reviewer', 'tenant-a', 'reviewer-a', 'viewer', 'active')")
    db.execute("INSERT INTO sites (id, tenant_id, name, status) VALUES ('site-a', 'tenant-a', 'Site A', 'active')")
    db.execute("""INSERT INTO sources
      (id, site_id, tenant_id, module, provider, source_type, display_name)
      VALUES ('source-a', 'site-a', 'tenant-a', 'neoagro', 'provider', 'sensor', 'Source A')""")
    db.execute("""INSERT INTO observations
      (id, site_id, tenant_id, source_id, module, metric, value, unit, observed_at,
       idempotency_key, verification_status, provenance_json)
      VALUES ('obs-a', 'site-a', 'tenant-a', 'source-a', 'neoagro', 'ec', 1.5, 'dS/m',
       '2026-05-10T10:00:00Z', 'key-a', 'unverified', '{}')""")
    db.execute("""INSERT INTO audit_events
      (id, tenant_id, actor_type, actor_id, action, entity_type, entity_id, details_json)
      VALUES ('audit-a', 'tenant-a', 'service', 'ingestion-service', 'observation.accepted',
       'observation', 'obs-a', '{}')""")
    db.execute("""INSERT INTO observation_reviewers
      (tenant_id, site_id, reviewer_subject, reviewer_role, status, assigned_by_subject, assignment_evidence_ref)
      VALUES ('tenant-a', 'site-a', 'reviewer-a', 'measurement_reviewer', 'active', 'owner-a', 'appointment:1')""")
    db.execute("""INSERT INTO observation_reviewer_events
      (id, tenant_id, site_id, reviewer_subject, reviewer_role, event_type, actor_subject, evidence_ref, request_id)
      VALUES ('reviewer-event-a', 'tenant-a', 'site-a', 'reviewer-a', 'measurement_reviewer',
       'assigned', 'owner-a', 'appointment:1', 'request-a')""")
    return db


def add_event(db, event_id, event_type):
    db.execute("""INSERT INTO observation_verification_events
      (id, tenant_id, site_id, observation_id, reviewer_subject, reviewer_role,
       event_type, evidence_ref, reason, request_id)
      VALUES (?, 'tenant-a', 'site-a', 'obs-a', 'reviewer-a', 'measurement_reviewer',
       ?, 'inspection:1', ?, ?)""",
       (event_id, event_type, None if event_type == "verified" else "documented review decision",
        "request-" + event_id))


def test_migration_creates_site_scoped_reviewer_and_verification_ledgers():
    db = database()
    tables = {row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    assert {"observation_reviewers", "observation_reviewer_events",
            "observation_verification_events"} <= tables
    indexes = {row[1] for row in db.execute(
        "PRAGMA index_list(observation_verification_events)").fetchall()}
    assert "idx_observation_verification_events_history" in indexes


def test_verified_transition_requires_event_and_is_revocable():
    db = database()
    add_event(db, "event-verify", "verified")
    db.execute("UPDATE observations SET verification_status='verified' WHERE id='obs-a'")
    assert db.execute("SELECT verification_status FROM observations WHERE id='obs-a'").fetchone() == ("verified",)
    add_event(db, "event-revoke", "revoked")
    db.execute("UPDATE observations SET verification_status='unverified' WHERE id='obs-a'")
    assert db.execute("SELECT verification_status FROM observations WHERE id='obs-a'").fetchone() == ("unverified",)
    assert db.execute("SELECT COUNT(*) FROM observation_verification_events").fetchone() == (2,)


def test_direct_status_edits_without_matching_review_event_are_blocked():
    db = database()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE observations SET verification_status='verified' WHERE id='obs-a'")


def test_rejected_observations_cannot_be_promoted_without_a_new_valid_state():
    db = database()
    add_event(db, "event-reject", "rejected")
    db.execute("UPDATE observations SET verification_status='rejected' WHERE id='obs-a'")
    with pytest.raises(sqlite3.IntegrityError):
        add_event(db, "event-reverify", "verified")


def test_review_history_is_append_only_and_tenant_site_bound():
    db = database()
    add_event(db, "event-verify", "verified")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE observation_verification_events SET reason='edited' WHERE id='event-verify'")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("DELETE FROM observation_verification_events WHERE id='event-verify'")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("""INSERT INTO observation_verification_events
          (id, tenant_id, site_id, observation_id, reviewer_subject, reviewer_role,
           event_type, evidence_ref, request_id)
          VALUES ('cross-site', 'tenant-a', 'site-b', 'obs-a', 'reviewer-a',
           'measurement_reviewer', 'verified', 'inspection:1', 'request-cross')""")


def test_revoked_reviewer_cannot_create_new_verification_events():
    db = database()
    db.execute("""INSERT INTO observation_reviewer_events
      (id, tenant_id, site_id, reviewer_subject, reviewer_role, event_type,
       actor_subject, evidence_ref, reason, request_id)
      VALUES ('reviewer-revoke', 'tenant-a', 'site-a', 'reviewer-a',
       'measurement_reviewer', 'revoked', 'owner-a', 'appointment:end',
       'Appointment ended', 'request-revoke')""")
    db.execute("""UPDATE observation_reviewers SET status='revoked'
      WHERE tenant_id='tenant-a' AND site_id='site-a' AND reviewer_subject='reviewer-a'""")
    with pytest.raises(sqlite3.IntegrityError):
        add_event(db, "event-verify", "verified")


def test_reviewer_status_cannot_be_changed_without_a_matching_event():
    db = database()
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("""UPDATE observation_reviewers SET status='revoked'
          WHERE tenant_id='tenant-a' AND site_id='site-a' AND reviewer_subject='reviewer-a'""")


def test_laboratory_report_evidence_stores_original_bytes_and_server_digest():
    db = database()
    document = b"%PDF-1.4\nlab report fixture\n%%EOF"
    digest = hashlib.sha256(document).hexdigest()
    db.execute("""INSERT INTO laboratory_report_evidence
      (id, tenant_id, site_id, evidence_type, file_name, media_type, byte_length,
       sha256, document_bytes, laboratory_name, report_number, issued_at, uploaded_by_subject)
      VALUES (?, 'tenant-a', 'site-a', 'laboratory_report', 'report.pdf',
       'application/pdf', ?, ?, ?, 'Declared Lab', 'RPT-001',
       '2026-10-01T10:30:00Z', 'owner-a')""",
       ("lab-report-a", len(document), digest, sqlite3.Binary(document)))
    stored = db.execute("""SELECT document_bytes, byte_length, sha256,
      verification_status FROM laboratory_report_evidence WHERE id='lab-report-a'""").fetchone()
    assert bytes(stored[0]) == document
    assert stored[1] == len(document)
    assert hashlib.sha256(bytes(stored[0])).hexdigest() == stored[2]
    assert stored[3] == "registered_unverified"


def test_laboratory_report_evidence_requires_matching_registration_event():
    db = database()
    document = b"%PDF-1.4\nlab report fixture\n%%EOF"
    digest = hashlib.sha256(document).hexdigest()
    db.execute("""INSERT INTO laboratory_report_evidence
      (id, tenant_id, site_id, evidence_type, file_name, media_type, byte_length,
       sha256, document_bytes, laboratory_name, report_number, issued_at, uploaded_by_subject)
      VALUES ('lab-report-a', 'tenant-a', 'site-a', 'laboratory_report', 'report.pdf',
       'application/pdf', ?, ?, ?, 'Declared Lab', 'RPT-001',
       '2026-10-01T10:30:00Z', 'owner-a')""",
       (len(document), digest, sqlite3.Binary(document)))
    db.execute("""INSERT INTO laboratory_report_evidence_events
      (id, evidence_id, tenant_id, site_id, event_type, actor_subject, request_id)
      VALUES ('lab-event-a', 'lab-report-a', 'tenant-a', 'site-a',
       'registered', 'owner-a', 'request-a')""")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("""INSERT INTO laboratory_report_evidence_events
          (id, evidence_id, tenant_id, site_id, event_type, actor_subject, request_id)
          VALUES ('lab-event-forged', 'lab-report-a', 'tenant-a', 'site-a',
           'registered', 'other-actor', 'request-b')""")


def test_laboratory_report_evidence_and_history_are_immutable():
    db = database()
    document = b"%PDF-1.4\nlab report fixture\n%%EOF"
    digest = hashlib.sha256(document).hexdigest()
    db.execute("""INSERT INTO laboratory_report_evidence
      (id, tenant_id, site_id, evidence_type, file_name, media_type, byte_length,
       sha256, document_bytes, laboratory_name, report_number, issued_at, uploaded_by_subject)
      VALUES ('lab-report-a', 'tenant-a', 'site-a', 'laboratory_report', 'report.pdf',
       'application/pdf', ?, ?, ?, 'Declared Lab', 'RPT-001',
       '2026-10-01T10:30:00Z', 'owner-a')""",
       (len(document), digest, sqlite3.Binary(document)))
    db.execute("""INSERT INTO laboratory_report_evidence_events
      (id, evidence_id, tenant_id, site_id, event_type, actor_subject, request_id)
      VALUES ('lab-event-a', 'lab-report-a', 'tenant-a', 'site-a',
       'registered', 'owner-a', 'request-a')""")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE laboratory_report_evidence SET file_name='changed.pdf' WHERE id='lab-report-a'")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("DELETE FROM laboratory_report_evidence WHERE id='lab-report-a'")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE laboratory_report_evidence_events SET actor_subject='forged' WHERE id='lab-event-a'")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("DELETE FROM laboratory_report_evidence_events WHERE id='lab-event-a'")
