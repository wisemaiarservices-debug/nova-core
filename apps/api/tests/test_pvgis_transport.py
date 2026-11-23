import asyncio

import pytest

from apps.api.services import pvgis


class _Chunk:
    def __init__(self, value):
        self.value = value

    def to_py(self):
        return self.value


class _ReadResult:
    def __init__(self, value=None, done=False):
        self.value = _Chunk(value) if value is not None else None
        self.done = done


class _Reader:
    def __init__(self, chunks):
        self.chunks = iter(chunks)
        self.cancelled = False
        self.released = False

    async def read(self):
        try:
            return _ReadResult(next(self.chunks))
        except StopIteration:
            return _ReadResult(done=True)

    async def cancel(self):
        self.cancelled = True

    def releaseLock(self):
        self.released = True


class _Body:
    def __init__(self, reader):
        self.reader = reader

    def getReader(self):
        return self.reader


class _Response:
    def __init__(self, reader):
        self.body = _Body(reader)


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
