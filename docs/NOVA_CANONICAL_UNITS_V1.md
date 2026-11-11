# NOVA canonical unit normalization contract v1

NOVA Core must preserve original measurements and units while supporting explicit, dimensional conversion to canonical reference units. This prevents a soil-moisture percentage, power rating, energy total, water flow and temperature from being compared as if they shared a dimension.

## Current reviewed dimensions

- Temperature: °C, °F, K → K.
- Length: mm, cm, m, km, ft → m.
- Area: m², hectares, km², acres → m².
- Volume: L, mL, m³ → m³.
- Flow: L/s, L/min, m³/h, m³/s → m³/s.
- Power: W, kW, MW → W.
- Energy: J, Wh, kWh, MWh → J.
- Voltage: mV, V, kV → V.
- Current: mA, A → A.
- Pressure: Pa, kPa, bar → Pa.
- Speed: m/s, km/h → m/s.
- Ratio: %, fraction → fraction.
- Irradiance: W/m², kW/m² → W/m².

## Rules

- Conversion is allowed only when both units are in the registry and have the same dimension.
- Temperature conversions use affine offsets; other listed conversions use scale factors.
- Unknown units (including unsupported sensor-specific units) fail closed. Do not guess based on spelling or magnitude.
- The original numeric value/unit are preserved in the normalized result.
- Conversion does not validate sensor calibration, physical plausibility, source trust, or measurement quality.
- Unit definitions must be reviewed and versioned as new domains/equipment are supported.

## Not implemented

No automatic observation ingestion integration, database schema change, unit ontology service, manufacturer-specific unit mapping, sensor calibration correction, or scientific plausibility rules are included.
