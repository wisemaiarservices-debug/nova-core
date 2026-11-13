"""SQLite invariants for tenant/site-scoped configuration reviewer governance."""
import sqlite3
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


def database():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for name in (
        "0001_initial.sql", "0002_tenant_isolation.sql",
        "0003_internal_request_nonces.sql", "0004_tenant_ownership_immutability.sql",
        "0005_tenant_site_configuration_history.sql", "0006_site_configuration_idempotency.sql",
        "0007_water_quality_criteria_registry.sql", "0008_water_quality_criteria_reviewer_events.sql",
        "0009_site_configuration_reviewers.sql",
    ):
        db.executescript((MIGRATIONS / name).read_text(encoding="utf-8"))
    db.executemany(
        "INSERT INTO tenants (id, display_name, status) VALUES (?, ?, 'active')",
        [("tenant-a", "Tenant A"), ("tenant-b", "Tenant B")],
    )
    db.executemany(
        "INSERT INTO sites (id, tenant_id, name) VALUES (?, ?, ?)",
        [("site-a", "tenant-a", "A"), ("site-b", "tenant-b", "B")],
    )
    return db


def assign(db, *, tenant="tenant-a", site="site-a", subject="reviewer-a",
           role="engineering_reviewer", actor="owner-a", evidence="evidence:assignment"):
    db.execute(
        """INSERT INTO tenant_site_configuration_reviewers
           (tenant_id, site_id, reviewer_subject, reviewer_role, status,
            assigned_by_subject, assignment_evidence_ref)
           VALUES (?, ?, ?, ?, 'active', ?, ?)""",
        (tenant, site, subject, role, actor, evidence),
    )


def event(db, *, tenant="tenant-a", site="site-a", subject="reviewer-a",
          role="engineering_reviewer", kind="assigned", actor="owner-a"):
    db.execute(
        """INSERT INTO tenant_site_configuration_reviewer_events
           (id, tenant_id, site_id, reviewer_subject, reviewer_role, event_type,
            actor_subject, evidence_ref, request_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'evidence:event', 'request-1')""",
        ("event-" + kind, tenant, site, subject, role, kind, actor),
    )


def test_assignment_is_scoped_to_existing_site_and_role_allowlist():
    db = database()
    assign(db)
    event(db)
    with pytest.raises(sqlite3.IntegrityError):
        assign(db, tenant="tenant-b", site="site-a", subject="cross-tenant")
    with pytest.raises(sqlite3.IntegrityError):
        assign(db, role="tenant_admin", subject="invalid-role")


def test_assignment_evidence_and_event_history_are_immutable():
    db = database()
    assign(db)
    event(db)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "UPDATE tenant_site_configuration_reviewers SET assignment_evidence_ref='forged' "
            "WHERE tenant_id='tenant-a' AND site_id='site-a' AND reviewer_subject='reviewer-a'"
        )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE tenant_site_configuration_reviewer_events SET evidence_ref='forged'")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("DELETE FROM tenant_site_configuration_reviewer_events")


def test_revocation_is_audited_and_terminal():
    db = database()
    assign(db)
    event(db)
    db.execute(
        """UPDATE tenant_site_configuration_reviewers SET status='revoked'
           WHERE tenant_id='tenant-a' AND site_id='site-a'
             AND reviewer_subject='reviewer-a' AND reviewer_role='engineering_reviewer'"""
    )
    event(db, kind="revoked")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """UPDATE tenant_site_configuration_reviewers SET status='active'
               WHERE tenant_id='tenant-a' AND site_id='site-a'
                 AND reviewer_subject='reviewer-a' AND reviewer_role='engineering_reviewer'"""
        )
    with pytest.raises(sqlite3.IntegrityError):
        event(db, kind="assigned")
    assert db.execute(
        "SELECT event_type FROM tenant_site_configuration_reviewer_events ORDER BY rowid"
    ).fetchall() == [("assigned",), ("revoked",)]


def test_suspended_tenant_cannot_record_reviewer_events():
    db = database()
    assign(db)
    db.execute("UPDATE tenants SET status='suspended' WHERE id='tenant-a'")
    with pytest.raises(sqlite3.IntegrityError):
        event(db)
