# NOVA Core

NOVA Core is the shared, multi-tenant platform foundation for **NOVA OS**, NeoHaven's operating system for sustainable infrastructure.

It provides the governed identity, tenant, site, asset, observation, evidence, measurement-quality and audit foundations that connect NOVA OS modules and infrastructure data sources. It is designed to support multiple domains without assuming that every site, customer, asset, sensor, unit, protocol or operating context is identical.

## Platform scope

NOVA Core is the shared foundation for:

- **NOVA Energy / NeoGrid** — energy assets, microgrids and storage
- **NOVA Agriculture / NeoAgro** — agricultural sites, environmental and production observations
- **NOVA Infrastructure / NeoCell** — infrastructure and connected systems
- **NOVA Twin and NOVA Intelligence** — governed foundations for future modelling, analysis and decision support

## V1 engineering priorities

NOVA Core V1 prioritizes reliable, explainable and secure foundations before claiming autonomous intelligence:

- Multi-tenant identity, membership, authorization and resource isolation
- Tenant-, site-, asset- and source-scoped observation ingestion and retrieval
- Explicit source-to-sensor identity and provenance
- Laboratory evidence registration and reviewable calibration records
- Independently reviewed observation, calibration and measurement-quality workflows
- Immutable governance and audit events, idempotent operations and fail-closed authorization
- Clear separation between registered, verified, assessed and operationally trusted data
- Stable APIs and integration contracts for NOVA OS and its domain modules

## Operating principles

- **Evidence before inference:** preserve source, scope, units, timestamps, calibration and provenance. Unknown values remain unknown.
- **Tenant isolation by design:** identity association does not itself grant tenant membership or resource access.
- **Human-governed decisions:** approvals and infrastructure actions require explicit authorization and review.
- **Truthful capability status:** a passing test, registered document or deterministic rule is not proof of scientific validity, a trained model or production readiness.
- **Adaptable infrastructure:** site-specific geometry, crops, soils, water systems, energy assets, sensors, gateways, protocols and measurement methods must be represented explicitly rather than assumed globally.

## Intelligence and decision-support roadmap

Forecasting, recommendations, scenario simulation, optimization, impact scoring and AI-assisted explanations are potential higher-level capabilities built on validated tenant-scoped evidence and governed services. They must be introduced with explicit input provenance, model or rule identity/version, reproducible evaluation, applicability limits and human oversight.

These capabilities must not be represented as live or production-ready merely because they appear in the platform workflow or roadmap. Where a service, model, data source or validation process is not connected and verified, its status must remain unavailable, planned or unverified.

## Conceptual data lifecycle

**Observe → Validate → Govern → Analyze → Decide → Measure**

This lifecycle describes the platform's intended architecture; it does not assert that every stage is currently deployed or enabled.

## Repository status

NOVA Core is under active V1 development. Draft pull requests and passing CI checks are not equivalent to merged code, production deployment, configured identity providers, verified customer data or operational readiness. See the individual service contracts and deployment documentation for the status and prerequisites of each capability.
