# NOVA water-quality criteria submission and independent review

## Routes

- `POST /api/v1/tenants/{tenant_id}/water-quality-criteria/{entry_id}/{version}/submit`
- `POST /api/v1/tenants/{tenant_id}/water-quality-criteria/{entry_id}/{version}/review`

Both routes require a valid Cloudflare Access JWT and pass through the signed gateway identity envelope and private tenant API Service Binding.

## Submission

An active tenant owner or tenant admin with exactly one active membership can submit a draft. The request body must be an empty JSON object. The server records the actor and request ID in an append-only `submitted_for_review` event. SQL lifecycle triggers allow submission only after `draft_created`; replayed, missing, terminal or already-submitted entries conflict.

## Independent review

Review requests accept only `reviewer_role`, `decision`, `evidence_ref`, and optional `reason`. The verified Access subject is the reviewer identity; no caller-supplied subject is accepted. The role must match an active reviewer assignment for the exact tenant and the criteria entry's jurisdiction. The tenant must be active. The criteria author cannot review their own entry.

Each decision is stored as an immutable approval record with a server-generated ID, timestamp and request ID. A rejection requires a reason and atomically appends a terminal `rejected` lifecycle event. An approval remains `submitted_for_review` until at least two distinct assigned subjects have approved and both the `regulatory_reviewer` and `domain_expert` roles are represented by active assignments. The second qualifying approval atomically appends the `approved` event. SQL triggers independently enforce reviewer assignment, jurisdiction, active tenant, author separation, lifecycle order and the two-role/two-subject requirement.

A reviewer who has been revoked cannot submit a new approval. Revocation between approvals prevents the final approval event because only currently active reviewer assignments count.

## Important limits

- Approval means the configured human reviewers approved this registry record within its declared scope. It is not proof that the source is authentic, law is current, the rule is legally applicable, the underlying science is correct, or the water is safe/suitable.
- The system does not verify reviewer qualifications, professional licensing, regulator delegation, laboratory accreditation, document signatures, or source-document hashes.
- Review evidence references are caller-declared; no external evidence ingestion or verification is performed.
- No irrigation, crop, water-treatment or operational action is authorized by these events.
- Example CI data is synthetic. No customer data, production deployment, remote migration or paid service is used.

## Verification

Tests cover owner/admin submission, denial of other members, active exact-scope reviewer matching, author self-review denial, first-review pending state, dual-role approval, rejection, duplicate/terminal conflicts, gateway identity forwarding, and full disposable local D1 + private Service Binding lifecycle integration.
