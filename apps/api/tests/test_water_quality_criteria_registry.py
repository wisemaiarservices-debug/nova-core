"""SQLite contract tests for the tenant-scoped water-quality criteria registry."""
import json
import sqlite3
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"


def database():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys = ON")
    for name in (
        "0001_initial.sql", "0002_tenant_isolation.sql",
        "0003_internal_request_nonces.sql",
        "0004_tenant_ownership_immutability.sql",
        "0005_tenant_site_configuration_history.sql",
        "0006_site_configuration_idempotency.sql",
        "0007_water_quality_criteria_registry.sql",
        "0008_water_quality_criteria_reviewer_events.sql",
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


def add_entry(db, *, tenant="tenant-a", entry_id="criteria-a", version="1.0",
              site="site-a", jurisdiction="TN", author="author-a"):
    body = {
        "id": entry_id, "jurisdiction": jurisdiction, "title": "Fixture only",
        "version": version, "published_on": "2026-01-01",
        "effective_from": "2026-02-01",
        "authority": {"name": "Fixture", "source_evidence_ref": "evidence:source",
                      "document_digest": "sha256:" + "a" * 64},
        "scope": {"crop_ids": ["olive"], "irrigation_methods": ["drip"],
                  "intended_uses": ["agricultural_irrigation"]},
        "criteria": [{"parameter": "ec", "unit": "dS/m", "operator": "max",
                      "value": 2, "reference_clause": "fixture",
                      "evidence_ref": "evidence:clause"}],
        "review": {"status": "draft", "approvals": []},
    }
    db.execute(
        """INSERT INTO water_quality_criteria_entries
           (id, tenant_id, site_id, jurisdiction, version, title, entry_json,
            source_document_sha256, source_evidence_ref, published_on,
            effective_from, created_by_subject)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (entry_id, tenant, site, jurisdiction, version, body["title"],
         json.dumps(body), "a" * 64, "evidence:source", "2026-01-01",
         "2026-02-01", author),
    )
    db.execute(
        """INSERT INTO water_quality_criteria_events
           (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id)
           VALUES (?, ?, ?, ?, 'draft_created', ?, 'req-create')""",
        ("event-" + entry_id, tenant, entry_id, version, author),
    )
    return body


def assign_reviewer(db, subject, role, *, tenant="tenant-a", jurisdiction="TN"):
    db.execute(
        """INSERT INTO water_quality_criteria_reviewers
           (tenant_id, reviewer_subject, reviewer_role, jurisdiction,
            assigned_by_subject, assignment_evidence_ref)
           VALUES (?, ?, ?, ?, 'tenant-owner', 'evidence:assignment')""",
        (tenant, subject, role, jurisdiction),
    )


def submit(db, entry_id="criteria-a", version="1.0"):
    db.execute(
        """INSERT INTO water_quality_criteria_events
           (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id)
           VALUES (?, 'tenant-a', ?, ?, 'submitted_for_review', 'author-a', 'req-submit')""",
        ("submit-" + entry_id, entry_id, version),
    )


def approve(db, entry_id, version, subject, role):
    db.execute(
        """INSERT INTO water_quality_criteria_approvals
           (id, tenant_id, entry_id, entry_version, jurisdiction, reviewer_subject,
            reviewer_role, decision, evidence_ref, reviewed_at, request_id)
           VALUES (?, 'tenant-a', ?, ?, 'TN', ?, ?, 'approve',
                   'evidence:review', '2026-03-01T10:00:00Z', 'req-approve')""",
        ("approval-" + subject, entry_id, version, subject, role),
    )


def test_ordered_migration_creates_registry_review_and_event_tables():
    db = database()
    names = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"water_quality_criteria_entries", "water_quality_criteria_reviewers",
            "water_quality_criteria_approvals", "water_quality_criteria_events"} <= names


def test_registry_entry_is_tenant_site_scoped_and_content_immutable():
    db = database()
    add_entry(db)
    with pytest.raises(sqlite3.IntegrityError):
        add_entry(db, entry_id="cross-tenant", tenant="tenant-b", site="site-a")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("UPDATE water_quality_criteria_entries SET title='changed' WHERE id='criteria-a'")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute("DELETE FROM water_quality_criteria_entries WHERE id='criteria-a'")


def test_reviewer_must_be_active_and_scoped_and_cannot_review_own_entry():
    db = database()
    add_entry(db)
    submit(db)
    assign_reviewer(db, "author-a", "regulatory_reviewer")
    with pytest.raises(sqlite3.IntegrityError, match="distinct from author"):
        approve(db, "criteria-a", "1.0", "author-a", "regulatory_reviewer")
    assign_reviewer(db, "reviewer-r", "regulatory_reviewer")
    with pytest.raises(sqlite3.IntegrityError, match="distinct from author"):
        approve(db, "criteria-a", "1.0", "reviewer-r", "domain_expert")


def test_approval_requires_exact_role_assignment_and_two_distinct_reviewer_roles():
    db = database()
    add_entry(db)
    submit(db)
    assign_reviewer(db, "reviewer-r", "regulatory_reviewer")
    assign_reviewer(db, "reviewer-d", "domain_expert")
    approve(db, "criteria-a", "1.0", "reviewer-r", "regulatory_reviewer")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """INSERT INTO water_quality_criteria_events
               (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id)
               VALUES ('premature-approved','tenant-a','criteria-a','1.0',
                       'approved','author-a','req-early')"""
        )
    approve(db, "criteria-a", "1.0", "reviewer-d", "domain_expert")
    db.execute(
        "UPDATE water_quality_criteria_reviewers SET status='revoked' WHERE reviewer_subject='reviewer-r'"
    )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """INSERT INTO water_quality_criteria_events
               (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id)
               VALUES ('revoked-reviewer-approved','tenant-a','criteria-a','1.0',
                       'approved','workflow','req-revoked')"""
        )
    assign_reviewer(db, "reviewer-r2", "regulatory_reviewer")
    approve(db, "criteria-a", "1.0", "reviewer-r2", "regulatory_reviewer")
    db.execute(
        """INSERT INTO water_quality_criteria_events
           (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id)
           VALUES ('approved','tenant-a','criteria-a','1.0','approved','workflow','req-approved')"""
    )


def test_unassigned_or_revoked_reviewers_cannot_approve():
    db = database()
    add_entry(db)
    submit(db)
    assign_reviewer(db, "reviewer-r", "regulatory_reviewer")
    db.execute(
        "UPDATE water_quality_criteria_reviewers SET status='revoked' WHERE reviewer_subject='reviewer-r'"
    )
    with pytest.raises(sqlite3.IntegrityError, match="active scoped reviewer"):
        approve(db, "criteria-a", "1.0", "reviewer-r", "regulatory_reviewer")


def test_lifecycle_requires_submit_before_approval_and_is_append_only():
    db = database()
    add_entry(db)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """INSERT INTO water_quality_criteria_events
               (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id)
               VALUES ('early','tenant-a','criteria-a','1.0','approved','workflow','req-early')"""
        )
    submit(db)
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """INSERT INTO water_quality_criteria_events
               (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id)
               VALUES ('duplicate-submit','tenant-a','criteria-a','1.0',
                       'submitted_for_review','author-a','req-submit')"""
        )
    with pytest.raises(sqlite3.IntegrityError, match="cannot be deleted"):
        db.execute("DELETE FROM water_quality_criteria_events WHERE entry_id='criteria-a'")


def test_suspended_tenant_cannot_create_registry_entries_or_events():
    db = database()
    add_entry(db)
    db.execute("UPDATE tenants SET status='suspended' WHERE id='tenant-a'")
    with pytest.raises(sqlite3.IntegrityError):
        add_entry(db, entry_id="blocked-entry")
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """INSERT INTO water_quality_criteria_events
               (id, tenant_id, entry_id, entry_version, event_type, actor_subject, request_id)
               VALUES ('blocked','tenant-a','criteria-a','1.0','retired','owner','req')"""
        )


def test_reviewer_assignment_and_revocation_events_are_append_only_and_state_bound():
    db = database()
    assign_reviewer(db, "reviewer-r", "regulatory_reviewer")
    db.execute(
        """INSERT INTO water_quality_criteria_reviewer_events
           (id, tenant_id, reviewer_subject, reviewer_role, jurisdiction,
            event_type, actor_subject, evidence_ref, request_id)
           VALUES ('review-event-1','tenant-a','reviewer-r','regulatory_reviewer',
                   'TN','assigned','tenant-owner','evidence:assignment','req-assign')"""
    )
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            """INSERT INTO water_quality_criteria_reviewer_events
               (id, tenant_id, reviewer_subject, reviewer_role, jurisdiction,
                event_type, actor_subject, evidence_ref, request_id)
               VALUES ('review-event-invalid','tenant-a','reviewer-r','regulatory_reviewer',
                       'TN','revoked','tenant-owner','evidence:revocation','req-invalid')"""
        )
    db.execute(
        "UPDATE water_quality_criteria_reviewers SET status='revoked' WHERE tenant_id='tenant-a' AND reviewer_subject='reviewer-r' AND reviewer_role='regulatory_reviewer'"
    )
    db.execute(
        """INSERT INTO water_quality_criteria_reviewer_events
           (id, tenant_id, reviewer_subject, reviewer_role, jurisdiction,
            event_type, actor_subject, evidence_ref, reason, request_id)
           VALUES ('review-event-2','tenant-a','reviewer-r','regulatory_reviewer',
                   'TN','revoked','tenant-owner','evidence:revocation','scope ended','req-revoke')"""
    )
    with pytest.raises(sqlite3.IntegrityError, match="immutable"):
        db.execute("UPDATE water_quality_criteria_reviewer_events SET reason='edited' WHERE id='review-event-2'")
    with pytest.raises(sqlite3.IntegrityError, match="cannot be deleted"):
        db.execute("DELETE FROM water_quality_criteria_reviewer_events WHERE id='review-event-1'")
    with pytest.raises(sqlite3.IntegrityError, match="cannot be reactivated"):
        db.execute(
            "UPDATE water_quality_criteria_reviewers SET status='active' WHERE tenant_id='tenant-a' AND reviewer_subject='reviewer-r'"
        )
    with pytest.raises(sqlite3.IntegrityError, match="assignment evidence is immutable"):
        db.execute(
            "UPDATE water_quality_criteria_reviewers SET assignment_evidence_ref='evidence:changed' WHERE tenant_id='tenant-a' AND reviewer_subject='reviewer-r'"
        )
