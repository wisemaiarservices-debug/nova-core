# NOVA Core Laboratory Report Evidence API

## Purpose and trust boundary

This API registers bounded laboratory-report PDFs as immutable, tenant/site-scoped evidence. The Worker decodes the submitted bytes, calculates SHA-256 itself, stores the original bytes in D1, and returns a stable evidence reference. Retrieval re-hashes the persisted bytes before returning them.

Registration status is always **registered_unverified**. A declared laboratory name, report number, issue date, sample reference, PDF signature and digest do **not** prove laboratory identity, accreditation, report authenticity, chain of custody, sample representativeness, analytical method validity or regulatory suitability. This API does not promote evidence to a verified state and does not make laboratory reports eligible for water-quality assessment.

## Upload

POST /api/v1/tenants/{tenant_id}/sites/{site_id}/laboratory-reports

Requires a verified Cloudflare Access identity, active tenant membership, an active tenant, a tenant owner/admin role and an exact read grant for the selected site. The gateway signs the identity envelope; caller-supplied identity headers are ignored.

Content type: application/json. Maximum request body: 1,500,000 bytes. Maximum decoded PDF: 1 MiB.

Example body:

    {
      "file_name": "laboratory-report-001.pdf",
      "media_type": "application/pdf",
      "laboratory_name": "Declared laboratory",
      "report_number": "REPORT-001",
      "sample_reference": "sample-001",
      "issued_at": "2026-10-01T10:30:00Z",
      "document_base64": "JVBERi0xLjQK..."
    }

The sample_reference field is optional. The API accepts only PDF media type, a .pdf filename without path separators, a valid issue date, and bytes beginning with the PDF magic signature. It does not parse, scan, or authenticate PDF contents.

Success returns id, evidence_ref (lab-report:{id}), server-computed lowercase SHA-256, byte length, registered_unverified status and an idempotency indicator. Re-uploading identical bytes to the same tenant/site returns the existing evidence record and does not append a second registration event. The same digest may be registered independently at another site.

## Retrieval

GET /api/v1/tenants/{tenant_id}/sites/{site_id}/laboratory-reports/{evidence_id}

Requires active tenant membership with read capability and an exact site read grant. Returns the metadata and original document as base64. Before returning bytes, the Worker checks stored byte length and recalculates SHA-256; a mismatch fails closed.

## Storage and retention

The original PDF is stored as a bounded D1 BLOB. Evidence metadata and its registration event are append-only; updates and deletes are blocked by database triggers. This implementation does not require or configure R2, external storage, paid services or production bindings.

Retention, deletion exceptions, legal holds, data residency, malware scanning, document parsing, independent laboratory verification and evidence-to-sample scientific validation require separate governed work. Do not upload personal or confidential documents unless the tenant's data rights and retention basis are established.

## Current assessment behavior

Water-quality sample assessment continues to accept only the existing verified persisted-observation path. A lab-report:{id} reference is not interchangeable with an observation:{id} reference. Laboratory evidence remains not_assessed until a separate verifier validates report contents, laboratory authority and sample identity under an approved workflow.
