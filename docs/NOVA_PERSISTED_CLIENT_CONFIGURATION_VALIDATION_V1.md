# Persisted client configuration validation

`apps/api/services/persisted_client_configuration.py` is the strict bridge between immutable D1 snapshots and the existing client onboarding/model-applicability contracts.

Before a stored snapshot can be used for onboarding assessment it:
1. Requires the exact supported schema identifier.
2. Recomputes SHA-256 over the exact stored UTF-8 JSON bytes and compares it to the stored digest.
3. Parses only a JSON object and validates it with the strict Pydantic `ClientConfiguration` contract (`extra="forbid"`).
4. Checks tenant ID, site ID and version against the independently selected database row identity.
5. Requires tenant and site profile versions to match the immutable snapshot version.

The validator does not authenticate or authorize a caller, verify the truth of submitted values, discover equipment, establish telemetry, or grant operational approval. A valid digest proves byte consistency only. Onboarding readiness and model applicability remain separate checks, and a research-only model stays research-only.
