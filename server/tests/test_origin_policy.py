from __future__ import annotations

import pytest

from app.server import LOCAL_DEV_ALLOWED_ORIGINS, _resolve_allowed_origins


def test_resolve_allowed_origins_defaults_localhost_for_insecure_mode() -> None:
    origins = _resolve_allowed_origins([], allow_insecure_ws=True)
    assert origins == LOCAL_DEV_ALLOWED_ORIGINS


def test_resolve_allowed_origins_requires_values_for_secure_mode() -> None:
    with pytest.raises(ValueError):
        _resolve_allowed_origins([], allow_insecure_ws=False)


def test_resolve_allowed_origins_requires_https_in_secure_mode() -> None:
    with pytest.raises(ValueError):
        _resolve_allowed_origins(["http://localhost:5173"], allow_insecure_ws=False)


def test_resolve_allowed_origins_normalizes_and_deduplicates() -> None:
    origins = _resolve_allowed_origins(
        [" https://bestmidi.com ", "https://bestmidi.com", "https://www.bestmidi.com"],
        allow_insecure_ws=False,
    )
    assert origins == ("https://bestmidi.com", "https://www.bestmidi.com")
