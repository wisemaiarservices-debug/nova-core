# AGENTS.md — NOVA Core

You are working on NOVA Core, the shared platform foundation of NOVA OS.

## Company and product context

NeoHaven is building NOVA OS, an operating system for sustainable infrastructure. NOVA Core provides shared, multi-tenant foundations for NOVA OS domains and modules, including NOVA Energy / NeoGrid, NOVA Agriculture / NeoAgro, NOVA Infrastructure / NeoCell, NOVA Twin and NOVA Intelligence.

NOVA Core is being developed as a V1 platform. Do not carry forward demo-specific milestones, temporary demo deadlines or prototype role descriptions as current product requirements.

## V1 engineering priorities

- Preserve tenant, site, asset, source and identity boundaries across all services.
- Build explicit identity, membership, authorization, provenance and audit foundations.
- Preserve source observations and evidence; do not silently rewrite, normalize, convert or infer missing measurements.
- Require explicit source-to-sensor mapping, applicable calibration and reviewed measurement policies where the workflow requires them.
- Make governance decisions independently reviewable and append-only where specified.
- Keep identity association separate from tenant membership, roles and resource grants.
- Preserve compatibility with NeoAgro, NeoGrid and NeoCell through documented, versioned contracts.
- Adapt to customer/site-specific geometry, assets, crops, soils, water, energy, sensors, gateways, units, protocols, firmware and sampling methods. Do not hard-code one pilot or demo's assumptions as global truth.
- Infrastructure recommendations and actions remain advisory and human-governed unless an explicitly authorized execution workflow is implemented and validated.

## Intelligence claims and capability gates

Forecasting, recommendations, scenario simulation, optimization, impact scoring and AI assistant explanations are roadmap capabilities, not automatically available services. Do not describe them as live, trained, validated or production-ready without evidence.

Any future rules or model service must identify its inputs, tenant/site scope, rule/model identity and version, provenance, applicability envelope, validation/evaluation evidence, limitations and human-approval requirements. Deterministic rules are not trained AI. Synthetic, seeded, demo, inferred and unverified data must be clearly distinguished from verified operational data.

## Engineering rules

- Do not generate toy examples or fabricate customer/operational data.
- Build shared services incrementally; avoid client-specific rewrites.
- Every feature should include architecture, database/API impact, tests, documentation and explicit operational limitations.
- Fail closed on unknown identity, authorization, tenant scope, source mapping or evidence requirements.
- Do not make production migrations, alter secrets/configuration, merge or deploy unless all required approvals, security gates, migration/rollback plans and end-to-end checks are satisfied.
- Passing CI proves only the tested code paths under the test conditions; it does not establish production configuration or scientific validity.

## Conceptual lifecycle

Observe → Validate → Govern → Analyze → Decide → Measure.

This is an architectural direction, not a claim that every stage or intelligence service is currently deployed.
