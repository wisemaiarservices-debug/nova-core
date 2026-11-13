# Water-quality criteria applicability evidence

`assessWaterQualityAgainstDeclaredCriteria(samples, context, criteriaSet)` is a comparison utility. It embeds no regulatory or agronomic thresholds. The caller must supply a criteria set with an authority, title, version, effective dates, evidence reference and clause-level provenance for every rule.

A rule is eligible only for an exact match on jurisdiction, crop identifier, irrigation method, intended use, parameter and unit. No unit conversion, synonym mapping, extrapolation or fallback threshold is performed. Samples outside the criteria set's effective period, ambiguous rules, incomplete provenance and missing context remain `not_assessed`.

The statuses `within_declared_criterion` and `outside_declared_criterion` describe only arithmetic comparison to the supplied rule. They do not mean safe, unsafe, suitable, unsuitable, legally compliant or non-compliant. The code does not independently authenticate the issuing authority, document, current legal status, laboratory accreditation, sampling protocol or applicability to a particular field.

A production criteria registry must separately govern source acquisition, document authenticity, jurisdictional scope, amendments and supersession, effective dates, units, parameter definitions, intended uses, crop and irrigation-method scope, expert approval and audit history. Criteria must not be silently promoted to universal rules or global model parameters. Human regulatory and domain-expert review remains mandatory; operational decisions remain unauthorized.
