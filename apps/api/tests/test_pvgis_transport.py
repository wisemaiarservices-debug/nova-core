import asyncio
import sys
import types
from datetime import date

import pytest

from apps.api.services import pvgis


class _Chunk:
    def __init__(self, value):
        self.value = value

    def to_py(self):
        # Pyodide converts JavaScript TypedArray buffers to memoryview.
        return memoryview(self.value)


class _ReadResult:
    def __init__(self, value=None, done=False):
        self.value = _Chunk(value) if value is not None else None
        self.done = done


class _Reader:
    def __init__(self, chunks):
        self.chunks = list(chunks)
        self.index = 0
        self.cancelled = False
        self.released = False

    async def read(self):
        if self.index >= len(self.chunks):
            return _ReadResult(done=True)
        value = self.chunks[self.index]
        self.index += 1
        return _ReadResult(value)

    async def cancel(self):
        self.cancelled = True

    def releaseLock(self):
        self.released = True


class _Body:
    def __init__(self, reader):
        self.reader = reader
        self.cancelled = False

    def getReader(self):
        return self.reader

    async def cancel(self):
        self.cancelled = True


class _Response:
    def __init__(self, reader, *, ok=True, content_type="application/json"):
        self.body = _Body(reader)
        self.ok = ok
        self.status = 200 if ok else 502
        self.headers = types.SimpleNamespace(get=lambda key: content_type if key == "content-type" else None)


def _install_worker_ffi(monkeypatch, fetch):
    js_module = types.ModuleType("js")
    js_module.Object = types.SimpleNamespace(fromEntries=object())
    js_module.fetch = fetch
    ffi_module = types.ModuleType("pyodide.ffi")
    ffi_module.to_js = lambda value, dict_converter=None: value
    pyodide_module = types.ModuleType("pyodide")
    pyodide_module.ffi = ffi_module
    monkeypatch.setitem(sys.modules, "js", js_module)
    monkeypatch.setitem(sys.modules, "pyodide", pyodide_module)
    monkeypatch.setitem(sys.modules, "pyodide.ffi", ffi_module)


def test_worker_response_body_is_joined_incrementally(monkeypatch):
    reader = _Reader([b'{"ok":', b'true}'])
    monkeypatch.setattr(pvgis, "MAX_RESPONSE_BYTES", 32)

    result = asyncio.run(pvgis._read_bounded_response(_Response(reader)))

    assert result == b'{"ok":true}'
    assert reader.cancelled is False
    assert reader.released is True


def test_worker_response_body_is_cancelled_immediately_over_limit(monkeypatch):
    reader = _Reader([b"x" * 8, b"y" * 8, b"z"])
    monkeypatch.setattr(pvgis, "MAX_RESPONSE_BYTES", 10)

    with pytest.raises(RuntimeError, match="2 MiB limit"):
        asyncio.run(pvgis._read_bounded_response(_Response(reader)))

    assert reader.cancelled is True
    assert reader.released is True


def test_worker_response_requires_streaming_body():
    with pytest.raises(RuntimeError, match="readable body"):
        asyncio.run(pvgis._read_bounded_response(object()))


def test_async_worker_fetch_uses_readable_stream_and_rejects_redirects(monkeypatch):
    reader = _Reader([b'{"outputs":', b'{"totals":{}}}'])
    response = _Response(reader)
    calls = []

    async def fake_fetch(url, options):
        calls.append((url, options))
        return response

    _install_worker_ffi(monkeypatch, fake_fetch)

    result = asyncio.run(
        pvgis.fetch_broadband_performance_async(
            36.8, 10.2, date(2024, 1, 1), date(2024, 1, 7)
        )
    )

    assert result == {"outputs": {"totals": {}}}
    assert len(calls) == 1
    assert calls[0][1]["redirect"] == "error"
    assert "latitude=36.8" in calls[0][0]
    assert reader.released is True
    assert reader.cancelled is False


def test_async_worker_fetch_cancels_oversized_stream(monkeypatch):
    reader = _Reader([b"x" * 8, b"y" * 8])
    response = _Response(reader)
    monkeypatch.setattr(pvgis, "MAX_RESPONSE_BYTES", 10)

    async def fake_fetch(url, options):
        return response

    _install_worker_ffi(monkeypatch, fake_fetch)

    with pytest.raises(RuntimeError, match="2 MiB limit"):
        asyncio.run(
            pvgis.fetch_broadband_performance_async(
                36.8, 10.2, date(2024, 1, 1), date(2024, 1, 7)
            )
        )

    assert reader.cancelled is True
    assert reader.released is True


def test_worker_response_stream_is_cancelled_when_read_is_cancelled():
    class _BlockingReader(_Reader):
        async def read(self):
            await asyncio.Event().wait()

    reader = _BlockingReader([])

    async def exercise_cancellation():
        task = asyncio.create_task(pvgis._read_bounded_response(_Response(reader)))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(exercise_cancellation())

    assert reader.cancelled is True
    assert reader.released is True


def test_async_worker_fetch_uses_one_deadline_for_headers_and_body(monkeypatch):
    reader = _Reader([b'{"outputs":{"totals":{}}}'])
    response = _Response(reader)
    deadlines = []
    original_wait_for = asyncio.wait_for

    async def fake_fetch(url, options):
        return response

    async def recording_wait_for(awaitable, timeout):
        deadlines.append(timeout)
        return await original_wait_for(awaitable, timeout=timeout)

    _install_worker_ffi(monkeypatch, fake_fetch)
    monkeypatch.setattr(pvgis.asyncio, "wait_for", recording_wait_for)

    result = asyncio.run(
        pvgis.fetch_broadband_performance_async(
            36.8, 10.2, date(2024, 1, 1), date(2024, 1, 7)
        )
    )

    assert result == {"outputs": {"totals": {}}}
    assert deadlines == [pvgis.TIMEOUT_SECONDS]


def test_worker_response_rejects_chunk_before_copy(monkeypatch):
    class OversizedView:
        def __len__(self):
            return 11

        def __bytes__(self):
            raise AssertionError("oversized chunk must not be copied")

    class OversizedReader:
        def __init__(self):
            self.cancelled = False
            self.released = False

        async def read(self):
            return types.SimpleNamespace(
                done=False,
                value=types.SimpleNamespace(to_py=lambda: OversizedView()),
            )

        async def cancel(self):
            self.cancelled = True

        def releaseLock(self):
            self.released = True

    reader = OversizedReader()
    monkeypatch.setattr(pvgis, "MAX_RESPONSE_BYTES", 10)

    with pytest.raises(RuntimeError, match="2 MiB limit"):
        asyncio.run(pvgis._read_bounded_response(_Response(reader)))

    assert reader.cancelled is True
    assert reader.released is True



@pytest.mark.parametrize(
    "content_type",
    [
        None,
        "",
        "text/plain",
        "application/notjson",
        "application/jsonp",
        "not-a-media-type",
    ],
)
def test_worker_fetch_rejects_non_json_media_types(monkeypatch, content_type):
    reader = _Reader([b'{"outputs":{}}'])
    response = _Response(reader, content_type=content_type)

    async def fake_fetch(url, options):
        return response

    with pytest.raises(RuntimeError, match="non-JSON content type"):
        asyncio.run(
            pvgis._fetch_worker_payload(fake_fetch, "https://example.invalid", {})
        )

    assert reader.released is False
    assert response.body.cancelled is True


def test_worker_fetch_cancels_non_success_response_body():
    reader = _Reader([b"upstream error"])
    response = _Response(reader, ok=False)

    async def fake_fetch(url, options):
        return response

    with pytest.raises(RuntimeError, match="HTTP 502"):
        asyncio.run(
            pvgis._fetch_worker_payload(fake_fetch, "https://example.invalid", {})
        )

    assert response.body.cancelled is True
    assert reader.released is False


@pytest.mark.parametrize(
    "content_type",
    [
        "application/json",
        "Application/JSON; charset=utf-8",
        "application/vnd.api+json",
    ],
)
def test_json_media_type_accepts_standard_and_vendor_json(content_type):
    assert pvgis._is_json_content_type(content_type) is True


def test_worker_fetch_rejects_invalid_json_body(monkeypatch):
    reader = _Reader([b"not-json"])
    response = _Response(reader)

    async def fake_fetch(url, options):
        return response

    _install_worker_ffi(monkeypatch, fake_fetch)

    with pytest.raises(RuntimeError, match="invalid JSON"):
        asyncio.run(
            pvgis.fetch_broadband_performance_async(
                36.8, 10.2, date(2024, 1, 1), date(2024, 1, 7)
            )
        )

    assert reader.released is True



@pytest.mark.parametrize(
    "content_type",
    [
        None,
        "",
        "text/plain",
        "application/notjson",
        "application/jsonp",
        "not-a-media-type",
    ],
)
def test_sync_fetch_rejects_non_json_media_types(monkeypatch, content_type):
    class _SyncResponse:
        headers = {"Content-Type": content_type}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, size):
            raise AssertionError("invalid media type must be rejected before body read")

    class _Opener:
        def open(self, request, timeout):
            assert timeout == pvgis.TIMEOUT_SECONDS
            return _SyncResponse()

    monkeypatch.setattr(pvgis, "build_opener", lambda handler: _Opener())

    with pytest.raises(RuntimeError, match="non-JSON content type"):
        pvgis.fetch_broadband_performance(
            36.8, 10.2, date(2024, 1, 1), date(2024, 1, 7)
        )


@pytest.mark.parametrize(
    "content_type",
    [
        "application/json",
        "Application/JSON; charset=utf-8",
        "application/vnd.api+json",
    ],
)
def test_sync_fetch_accepts_standard_and_vendor_json_media_types(monkeypatch, content_type):
    class _SyncResponse:
        headers = {"Content-Type": content_type}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, size):
            assert size == pvgis.MAX_RESPONSE_BYTES + 1
            return b'{"outputs":{"totals":{}}}'

    class _Opener:
        def open(self, request, timeout):
            return _SyncResponse()

    monkeypatch.setattr(pvgis, "build_opener", lambda handler: _Opener())

    result = pvgis.fetch_broadband_performance(
        36.8, 10.2, date(2024, 1, 1), date(2024, 1, 7)
    )

    assert result == {"outputs": {"totals": {}}}
