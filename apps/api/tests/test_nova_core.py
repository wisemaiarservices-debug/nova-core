import asyncio
import pytest
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError

from apps.api.main import ALLOWED_ORIGINS, SiteState, app, explain, forecast, impact_score, input_provenance, recommend, run_recommendation, simulate


def test_forecast_flags_high_heat_and_low_moisture_for_review():
    result = forecast(SiteState(temperature_c=39, soil_moisture_pct=31))
    assert result["heat_risk"] == "high_screening_flag"
    assert result["yield_risk"] == "review_required_heat_and_low_moisture"
    assert result["water_demand_delta_pct"] is None
    assert result["methodology"]["calibrated_model"] is False


def test_default_inputs_are_explicitly_marked_synthetic():
    result = input_provenance(SiteState())
    assert result["data_mode"] == "synthetic_defaults"
    assert result["synthetic_defaults_present"] is True
    assert result["caller_supplied_values_verified"] is False
    assert "temperature_c" in result["defaulted_fields"]


def test_partial_payload_is_marked_mixed():
    result = input_provenance(SiteState(temperature_c=32))
    assert result["data_mode"] == "mixed_synthetic_and_caller_supplied"
    assert result["provided_fields"] == ["temperature_c"]
    assert "soil_moisture_pct" in result["defaulted_fields"]


def test_full_payload_is_caller_supplied_but_unverified():
    state = SiteState(site_id="field-01", temperature_c=32, soil_moisture_pct=45, solar_kw=10, battery_soc_pct=80, water_use_m3_today=12, gateway_health_pct=95)
    result = input_provenance(state)
    assert result["data_mode"] == "caller_supplied_unverified"
    assert result["defaulted_fields"] == []
    assert result["caller_supplied_values_verified"] is False


def test_impact_is_not_fabricated_from_insufficient_inputs():
    result = impact_score(SiteState())
    assert result["status"] == "not_estimable_from_available_inputs"
    assert result["water_saved_m3"] is None
    assert result["energy_shifted_kwh"] is None
    assert result["carbon_reduction_kg"] is None


def test_recommendation_is_review_only_and_has_no_fake_confidence():
    rec = recommend(SiteState())
    assert rec.requires_operator_review is True
    assert rec.confidence is None
    assert "verify field conditions" in rec.title.lower()


def test_scenario_does_not_invent_an_optimized_outcome():
    result = simulate(SiteState())
    assert result["comparison_status"] == "optimized_case_not_estimable"
    assert result["optimized"] is None
    assert result["impact"]["water_saved_m3"] is None


def test_explanation_discloses_method_and_limits():
    result = explain(SiteState())
    assert result["requires_operator_review"] is True
    assert result["methodology"]["trained_machine_learning"] is False
    assert result["input_provenance"]["synthetic_defaults_present"] is True


@pytest.mark.parametrize("field,value", [("soil_moisture_pct", 101), ("battery_soc_pct", -1), ("gateway_health_pct", 101), ("solar_kw", -0.1), ("water_use_m3_today", -1)])
def test_physical_input_ranges_are_validated(field, value):
    with pytest.raises(ValidationError):
        SiteState(**{field: value})


def test_recommendation_endpoint_preserves_explicit_review_status():
    result = run_recommendation(SiteState())
    assert result["status"] == "review_required"
    assert result["recommendation"]["requires_operator_review"] is True


def test_nasa_power_parser_normalizes_fill_values_and_keeps_metadata():
    from apps.api.services.nasa_power import parse_daily_response

    payload = {
        "header": {"title": "NASA POWER Daily", "sources": ["MERRA2"], "time_standard": "UTC", "fill_value": -999, "latitude": 36.8, "longitude": 10.2},
        "parameters": {"T2M": {"units": "C"}, "PRECTOTCORR": {"units": "mm/day"}},
        "properties": {"parameter": {"T2M": {"20260101": 18.5, "20260102": -999}, "PRECTOTCORR": {"20260101": 0.0, "20260102": 2.4}}},
    }
    result = parse_daily_response(payload)
    assert result["records"][0]["values"]["T2M"] == 18.5
    assert result["records"][1]["values"]["T2M"] is None
    assert result["records"][1]["values"]["PRECTOTCORR"] == 2.4
    assert result["units"]["T2M"] == "C"
    assert result["source_metadata"]["sources"] == ["MERRA2"]


def test_nasa_power_parser_rejects_empty_parameter_payload():
    from apps.api.services.nasa_power import parse_daily_response

    with pytest.raises(ValueError):
        parse_daily_response({"properties": {"parameter": {}}})


def test_cors_is_configurable_and_disallows_credentials():
    middleware = [item for item in app.user_middleware if item.cls is CORSMiddleware]
    assert middleware
    config = middleware[0].kwargs
    assert "http://localhost:3000" in ALLOWED_ORIGINS
    assert "http://localhost:8504" in config["allow_origins"]
    assert "https://nova-os-pied.vercel.app" in config["allow_origins"]
    assert "https://neohaven-nova-os-website-git-feat-n-4294c9-neo-haven-urban-labs.vercel.app" in config["allow_origins"]
    assert "https://neoagro-git-fix-neoagro-provenance-56a89b-neo-haven-urban-labs.vercel.app" in config["allow_origins"]
    assert "https://neocell-git-fix-neocell-api-health-52be8d-neo-haven-urban-labs.vercel.app" in config["allow_origins"]
    assert "https://neogrid-git-fix-neogrid-provenance-43da6f-neo-haven-urban-labs.vercel.app" in config["allow_origins"]
    assert config["allow_credentials"] is False
    assert "OPTIONS" in config["allow_methods"]


def test_nasa_power_async_adapter_uses_local_fallback(monkeypatch):
    from apps.api.services import nasa_power
    from datetime import date

    expected = {"records": [{"date": "20260101", "values": {"T2M": 18.5}}]}
    monkeypatch.setattr(nasa_power, "fetch_daily_point", lambda *args: expected)
    result = asyncio.run(
        nasa_power.fetch_daily_point_async(
            36.8, 10.2, date(2026, 1, 1), date(2026, 1, 1)
        )
    )
    assert result == expected


def test_storage_status_is_explicitly_unconfigured_without_binding():
    from apps.api.services.d1_storage import storage_status, EXPECTED_TABLES

    result = asyncio.run(storage_status())
    assert result["status"] == "unconfigured"
    assert result["engine"] == "cloudflare_d1"
    assert result["read_only"] is True
    assert set(result["missing_tables"]) == EXPECTED_TABLES
    assert result["writes_performed"] is False


def test_storage_status_reports_complete_schema_from_read_only_binding():
    from types import SimpleNamespace
    from apps.api.services.d1_storage import storage_status, EXPECTED_TABLES

    class FakeStatement:
        def bind(self, *args):
            return self

        async def run(self):
            return SimpleNamespace(
                results=[{"name": name} for name in sorted(EXPECTED_TABLES)]
            )

    class FakeDatabase:
        def prepare(self, query):
            assert "SELECT name FROM sqlite_master" in query
            return FakeStatement()

    result = asyncio.run(storage_status(FakeDatabase()))
    assert result["status"] == "ready"
    assert result["present_tables"] == sorted(EXPECTED_TABLES)
    assert result["missing_tables"] == []
    assert result["writes_performed"] is False


def test_storage_status_reports_incomplete_schema():
    from apps.api.services.d1_storage import storage_status

    class FakeStatement:
        def bind(self, *args):
            return self

        async def run(self):
            return type("Result", (), {"results": [{"name": "sites"}]})()

    class FakeDatabase:
        def prepare(self, query):
            return FakeStatement()

    result = asyncio.run(storage_status(FakeDatabase()))
    assert result["status"] == "schema_incomplete"
    assert result["present_tables"] == ["sites"]
    assert "observations" in result["missing_tables"]


def test_nasa_power_transport_reads_with_a_hard_response_limit(monkeypatch):
    from apps.api.services import nasa_power

    class FakeResponse:
        def __init__(self, body):
            self.body = body
            self.requested = None

        def read(self, size):
            self.requested = size
            return self.body[:size]

    monkeypatch.setattr(nasa_power, "NASA_POWER_MAX_RESPONSE_BYTES", 8)
    response = FakeResponse(b'{"ok":1}')
    assert nasa_power._read_bounded_response(response) == b'{"ok":1}'
    assert response.requested == 9

    oversized = FakeResponse(b'{"ok":12345}')
    with pytest.raises(RuntimeError, match="2 MiB limit"):
        nasa_power._read_bounded_response(oversized)
    assert oversized.requested == 9


def test_nasa_power_urllib_redirect_handler_refuses_redirects():
    from apps.api.services.nasa_power import _RejectRedirects

    handler = _RejectRedirects()
    assert handler.redirect_request(
        None, None, 302, "Found", {}, "https://example.invalid/redirect"
    ) is None


def test_nasa_power_workers_body_reader_enforces_streaming_limit(monkeypatch):
    from types import SimpleNamespace
    from apps.api.services import nasa_power

    class FakeReader:
        def __init__(self):
            self.chunks = [b"1234", b"5678", b"9"]
            self.cancelled = False
            self.released = False

        async def read(self):
            if self.chunks:
                return SimpleNamespace(done=False, value=SimpleNamespace(to_py=lambda: self.chunks.pop(0)))
            return SimpleNamespace(done=True, value=None)

        async def cancel(self):
            self.cancelled = True

        def releaseLock(self):
            self.released = True

    reader = FakeReader()
    response = SimpleNamespace(body=SimpleNamespace(getReader=lambda: reader))
    monkeypatch.setattr(nasa_power, "NASA_POWER_MAX_RESPONSE_BYTES", 8)

    with pytest.raises(RuntimeError, match="2 MiB limit"):
        asyncio.run(nasa_power._read_worker_body(response))
    assert reader.cancelled is True
    assert reader.released is True



def test_nasa_power_urllib_opener_installs_redirect_rejection(monkeypatch):
    from datetime import date
    from urllib.error import HTTPError
    from apps.api.services import nasa_power

    class FakeOpener:
        handlers = []

        def open(self, request, timeout):
            assert timeout == nasa_power.NASA_POWER_TIMEOUT_SECONDS
            raise HTTPError(request.full_url, 302, "Found", {}, None)

    opener = FakeOpener()
    def fake_build_opener(handler):
        opener.handlers = [handler]
        return opener

    monkeypatch.setattr(nasa_power, "build_opener", fake_build_opener)
    with pytest.raises(RuntimeError, match="NASA POWER request failed"):
        nasa_power.fetch_daily_point(36.8, 10.2, date(2026, 1, 1), date(2026, 1, 1))
    assert any(isinstance(handler, nasa_power._RejectRedirects) for handler in opener.handlers)


def test_nasa_power_workers_fetch_options_reject_redirects():
    from apps.api.services.nasa_power import _worker_fetch_options

    captured = {}
    def fake_to_js(value, *, dict_converter):
        captured["value"] = value
        captured["converter"] = dict_converter
        return value

    marker = object()
    options = _worker_fetch_options(fake_to_js, marker)
    assert options["method"] == "GET"
    assert options["headers"]["Accept"] == "application/json"
    assert options["redirect"] == "error"
    assert captured["converter"] is marker

def test_nasa_power_workers_fetch_payload_checks_status_and_decodes_body():
    from types import SimpleNamespace
    from apps.api.services.nasa_power import _fetch_worker_payload

    class FakeReader:
        def __init__(self):
            self.done = False

        async def read(self):
            if self.done:
                return SimpleNamespace(done=True, value=None)
            self.done = True
            return SimpleNamespace(
                done=False,
                value=SimpleNamespace(to_py=lambda: b'{"properties":{"parameter":{"T2M":{}}}}'),
            )

        async def cancel(self):
            pass

        def releaseLock(self):
            pass

    response = SimpleNamespace(
        ok=True,
        headers=SimpleNamespace(get=lambda key: None),
        body=SimpleNamespace(getReader=FakeReader),
    )
    called = {}

    async def fake_fetch(url, options):
        called["url"] = url
        called["options"] = options
        return response

    payload = asyncio.run(_fetch_worker_payload(fake_fetch, "https://example.invalid", {}))
    assert payload == {"properties": {"parameter": {"T2M": {}}}}
    assert called["url"] == "https://example.invalid"

def test_nasa_power_workers_body_reader_cancels_stream_when_read_is_cancelled():
    from types import SimpleNamespace
    from apps.api.services import nasa_power

    class BlockingReader:
        def __init__(self):
            self.cancelled = False
            self.released = False

        async def read(self):
            await asyncio.Event().wait()

        async def cancel(self):
            self.cancelled = True

        def releaseLock(self):
            self.released = True

    reader = BlockingReader()
    response = SimpleNamespace(body=SimpleNamespace(getReader=lambda: reader))

    async def exercise():
        task = asyncio.create_task(nasa_power._read_worker_body(response))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(exercise())
    assert reader.cancelled is True
    assert reader.released is True


def test_nasa_power_workers_body_reader_preserves_read_error_when_lock_release_fails():
    from types import SimpleNamespace
    from apps.api.services import nasa_power

    class FailingReader:
        def __init__(self):
            self.cancelled = False

        async def read(self):
            raise RuntimeError("original stream read failure")

        async def cancel(self):
            self.cancelled = True

        def releaseLock(self):
            raise ValueError("lock cleanup failure")

    reader = FailingReader()
    response = SimpleNamespace(body=SimpleNamespace(getReader=lambda: reader))

    with pytest.raises(RuntimeError, match="original stream read failure"):
        asyncio.run(nasa_power._read_worker_body(response))

    assert reader.cancelled is True
