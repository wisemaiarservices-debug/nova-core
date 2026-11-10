from __future__ import annotations

import json
from datetime import date
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

NASA_POWER_URL = "https://power.larc.nasa.gov/api/temporal/daily/point"
NASA_POWER_PARAMETERS = (
    "T2M,T2M_MAX,T2M_MIN,RH2M,PRECTOTCORR,WS10M,ALLSKY_SFC_SW_DWN"
)


def parse_daily_response(payload: dict[str, Any]) -> dict[str, Any]:
    properties = payload.get("properties") or {}
    parameter_data = properties.get("parameter") or {}
    if not parameter_data:
        raise ValueError("NASA POWER response did not contain daily parameter data")

    header = payload.get("header") or {}
    parameter_metadata = payload.get("parameters") or {}
    fill_value = header.get("fill_value", -999)
    units = {
        name: metadata.get("units")
        for name, metadata in parameter_metadata.items()
        if isinstance(metadata, dict)
    }
    dates = sorted({day for values in parameter_data.values() for day in values})
    records = []
    for day in dates:
        values: dict[str, float | None] = {}
        for name, series in parameter_data.items():
            value = series.get(day)
            if value is None or value == fill_value:
                values[name] = None
            else:
                values[name] = value
        records.append({"date": day, "values": values})

    return {
        "records": records,
        "units": units,
        "source_metadata": {
            "title": header.get("title"),
            "sources": header.get("sources", []),
            "time_standard": header.get("time_standard", "LST"),
            "latitude": header.get("latitude"),
            "longitude": header.get("longitude"),
            "fill_value": fill_value,
        },
    }


def fetch_daily_point(
    latitude: float, longitude: float, start_date: date, end_date: date
) -> dict[str, Any]:
    query = {
        "parameters": NASA_POWER_PARAMETERS,
        "community": "AG",
        "longitude": longitude,
        "latitude": latitude,
        "start": start_date.strftime("%Y%m%d"),
        "end": end_date.strftime("%Y%m%d"),
        "format": "JSON",
        "time-standard": "UTC",
    }
    request = Request(
        f"{NASA_POWER_URL}?{urlencode(query)}",
        headers={"User-Agent": "NOVA-Core/0.2 (NeoHaven Urban Labs)"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError) as exc:
        raise RuntimeError(f"NASA POWER request failed: {exc}") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("NASA POWER returned an invalid JSON response") from exc
    return parse_daily_response(payload)
