"""The packaged worker's self-check proves the downloads' own certificate authorities (R476 c)."""
from __future__ import annotations

import json
import os
import re
import ssl
import sys
from pathlib import Path

import pytest

PACKAGING = Path(__file__).resolve().parents[1] / "packaging"
sys.path.insert(0, str(PACKAGING))
import entry  # noqa: E402

from ao_worker import fetch  # noqa: E402

LINE = re.compile(r"^[1-9]\d* authorities from the app's own list$")


@pytest.fixture
def cert_env(monkeypatch):
    """The machine's settings before the check, which it must restore exactly."""
    monkeypatch.setenv("SSL_CERT_FILE", "/somewhere/the-admins.pem")
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)


def test_the_tls_check_counts_the_apps_own_authorities_with_the_default_paths_absent(cert_env):
    assert LINE.match(entry.tls_check())
    assert os.environ["SSL_CERT_FILE"] == "/somewhere/the-admins.pem"
    assert "SSL_CERT_DIR" not in os.environ


def test_the_tls_check_reads_the_context_with_the_default_paths_absent(cert_env, monkeypatch):
    seen = {}
    real = fetch.tls_context

    def spy():
        seen.update({k: os.environ.get(k) for k in ("SSL_CERT_FILE", "SSL_CERT_DIR")})
        return real()

    monkeypatch.setattr(fetch, "tls_context", spy)
    entry.tls_check()
    assert seen["SSL_CERT_FILE"] and not os.path.exists(seen["SSL_CERT_FILE"])
    assert seen["SSL_CERT_DIR"] and not os.path.exists(seen["SSL_CERT_DIR"])


def test_the_tls_check_fails_without_the_apps_list(cert_env, monkeypatch, tmp_path):
    monkeypatch.setattr(fetch, "_ca_file", lambda: str(tmp_path / "gone" / "cacert.pem"))
    with pytest.raises(RuntimeError):
        entry.tls_check()
    assert os.environ["SSL_CERT_FILE"] == "/somewhere/the-admins.pem"


def test_the_tls_check_fails_when_the_context_holds_no_authorities(cert_env, monkeypatch):
    monkeypatch.setattr(fetch, "tls_context", lambda: ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT))
    with pytest.raises(RuntimeError):
        entry.tls_check()
    assert os.environ["SSL_CERT_FILE"] == "/somewhere/the-admins.pem"
    assert "SSL_CERT_DIR" not in os.environ


def test_in_a_bundle_the_list_must_lie_inside_it(cert_env, monkeypatch, tmp_path):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    with pytest.raises(RuntimeError, match="inside"):
        entry.tls_check()
    monkeypatch.setattr(sys, "_MEIPASS", str(Path(fetch._ca_file()).parent.parent), raising=False)
    assert LINE.match(entry.tls_check())


def test_the_self_check_reports_tls_and_fails_on_it(monkeypatch, capsys):
    monkeypatch.setattr(entry, "tls_check", lambda: "7 authorities from the app's own list")
    entry.self_check()
    out = json.loads(capsys.readouterr().out)
    assert out["versions"]["tls"] == "7 authorities from the app's own list"

    def broken():
        raise RuntimeError("the app's own list of certificate authorities is missing")

    monkeypatch.setattr(entry, "tls_check", broken)
    assert entry.self_check() == 1
    out = json.loads(capsys.readouterr().out)
    assert out["ok"] is False and "list of certificate authorities is missing" in out["failed"]["tls"]
