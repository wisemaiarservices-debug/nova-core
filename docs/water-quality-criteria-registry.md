# Water-quality criteria registry governance

This module defines a pure, in-memory registry-entry contract and an applicability resolver. It does not create database tables, persistence, source ingestion, digital signatures, reviewer authentication, regulatory-source verification, or an operational approval route.

Each entry carries a stable identifier, jurisdiction, authority/source evidence reference, SHA-256 document digest, title/version, publication and effective dates, explicit crop/irrigation/use scope, clause-level criterion provenance, review state and reviewer attestations. The digest shape is checked only; the document is not fetched or hashed by this module.

An entry resolves only when its declared review status is \`approved\`, both distinct reviewer roles (\`regulatory_reviewer\` and \`domain_expert\`) have dated evidence-backed attestations, tenant/site scope (when specified) matches exactly, and jurisdiction/crop/method/intended-use scope matches exactly. Non-approved, expired, future-effective, malformed or out-of-scope entries remain not assessed.

Reviewer IDs and evidence references are self-declared strings in this pure helper. They are not authenticated. Two role attestations are a workflow gate, not proof of independence, competence, legal authority or valid approval. Source authority, document authenticity, amendments, supersession, current law and the meaning of thresholds require independent verification.

No regulatory or agronomic thresholds are embedded. The example fixtures are illustrative and are not legal data. This module does not perform unit conversion, parameter aliasing, scientific suitability assessment, water-quality safety determination or operational authorization. The registry must be persisted with append-only audit history and access controls before production use; no persistence or API route is added here.
