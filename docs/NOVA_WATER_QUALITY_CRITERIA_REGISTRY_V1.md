# Water-quality criteria registry storage contract

Migration \`0007\` adds tenant-scoped storage primitives for versioned criteria entries, reviewer assignments, evidence-backed reviewer decisions and append-only lifecycle events.

- Every entry belongs to a tenant and may optionally be scoped to a site. It carries a jurisdiction, version, canonical entry JSON, source-document digest, source evidence reference and publication/effective dates.
- Reviewer assignments are tenant- and jurisdiction-scoped, role-specific and revocable. The supported roles are \`regulatory_reviewer\` and \`domain_expert\`.
- Approval records require an active, matching reviewer assignment and prevent the entry author from approving their own entry.
- An \`approved\` lifecycle event is blocked unless at least one distinct active reviewer from each required role has supplied an approval record.
- Entry content, reviewer identity/scope, approval records and lifecycle events are append-only. Reviewer revocation changes status without erasing history.
- Foreign keys prevent cross-tenant or cross-site references. Suspended tenants cannot create new entries or lifecycle events.

This is a database contract only. It does not add a Worker route, authenticated reviewer provisioning, cryptographic signature verification, source-document fetching/hashing, legal-authority authentication, regulatory interpretation, effective-law verification, or operational approval. The reviewer assignment table must only be provisioned through a separately authenticated administrative workflow; this PR does not provide one. Existing entries and fixtures contain no real regulatory thresholds.

The SQL lifecycle guards enforce distinct reviewer subjects and role assignments, but the database does not prove reviewer competence, independence outside the two identities, document authenticity or correctness of declared evidence references. A future API must derive the reviewer subject from the verified gateway identity, never from request JSON, and must insert approval and lifecycle events atomically.
