"""The certificate authorities the worker's downloads trust (R476).

The packaged worker must not depend on the OpenSSL default paths of the machine it was built on:
its download context is built from the app's own list (certifi's file, inside the bundle) and, in
addition, the machine's default store. A local HTTPS server with a throw-away authority stands in
for the download hosts; nothing here reaches the network.
"""
from __future__ import annotations

import datetime
import ipaddress
import logging
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from ao_worker import fetch

BODY = b"hello over tls\n"


def _name(cn: str) -> x509.Name:
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])


def make_pki(folder: Path) -> dict[str, Path]:
    """A throw-away authority and a certificate for 127.0.0.1 signed by it (PEM files in `folder`)."""
    now = datetime.datetime.now(datetime.timezone.utc)
    ca_key = ec.generate_private_key(ec.SECP256R1())
    ca = (x509.CertificateBuilder().subject_name(_name("ao test authority")).issuer_name(_name("ao test authority"))
          .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=1))
          .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
          .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                       data_encipherment=False, key_agreement=False, key_cert_sign=True, crl_sign=True,
                                       encipher_only=False, decipher_only=False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .sign(ca_key, hashes.SHA256()))
    key = ec.generate_private_key(ec.SECP256R1())
    cert = (x509.CertificateBuilder().subject_name(_name("127.0.0.1")).issuer_name(ca.subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
            .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    out = {"ca": folder / "ca.pem", "cert": folder / "server.pem", "key": folder / "server.key"}
    out["ca"].write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    out["cert"].write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    out["key"].write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                             serialization.NoEncryption()))
    return out


class TlsServer:
    def __init__(self, pki: dict[str, Path]):
        class H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):  # noqa: ANN002
                pass

            def do_GET(self):  # noqa: N802
                self.send_response(200)
                self.send_header("Content-Length", str(len(BODY)))
                self.end_headers()
                self.wfile.write(BODY)

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.server.daemon_threads = True
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(pki["cert"], pki["key"])
        self.server.socket = ctx.wrap_socket(self.server.socket, server_side=True)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"https://127.0.0.1:{self.server.server_address[1]}/file"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def no_proxy(monkeypatch):
    for k in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        monkeypatch.delenv(k, raising=False)


@pytest.fixture
def no_default_paths(monkeypatch, tmp_path):
    """The machine's OpenSSL default paths absent, as on a Mac that is not the build machine."""
    monkeypatch.setenv("SSL_CERT_FILE", str(tmp_path / "nonexistent" / "cert.pem"))
    monkeypatch.setenv("SSL_CERT_DIR", str(tmp_path / "nonexistent" / "certs"))


@pytest.fixture
def pki(tmp_path):
    (tmp_path / "pki").mkdir()
    return make_pki(tmp_path / "pki")


@pytest.fixture
def server(pki, no_proxy):
    s = TlsServer(pki)
    yield s
    s.close()


def _causes(e: BaseException) -> list[BaseException]:
    out, seen = [], set()
    while e is not None and id(e) not in seen:
        seen.add(id(e))
        out.append(e)
        if getattr(e, "reason", None) is not None and isinstance(e.reason, BaseException):
            out.append(e.reason)
        e = e.__cause__ or e.__context__
    return out


def _verifies(ctx: ssl.SSLContext) -> None:
    assert ctx.verify_mode == ssl.CERT_REQUIRED
    assert ctx.check_hostname is True


def test_the_download_handler_has_authorities_without_the_default_paths(no_default_paths):
    ctx = fetch._WatchedHTTPS(fetch.Sockets())._context
    assert ctx.cert_store_stats()["x509_ca"] > 0
    _verifies(ctx)


def test_tls_context_holds_the_apps_own_list_and_verifies(no_default_paths):
    ctx = fetch.tls_context()
    assert ctx.cert_store_stats()["x509_ca"] > 0
    _verifies(ctx)


def test_the_download_handler_uses_tls_context(monkeypatch):
    made = []
    real = fetch.tls_context

    def spy():
        made.append(real())
        return made[-1]

    monkeypatch.setattr(fetch, "tls_context", spy)
    h = fetch._WatchedHTTPS(fetch.Sockets())
    assert made and h._context is made[-1]


def test_the_machines_store_is_still_trusted(server, pki, monkeypatch, tmp_path):
    # An administrator's SSL_CERT_FILE (or Linux's system store) keeps working.
    monkeypatch.setenv("SSL_CERT_FILE", str(pki["ca"]))
    monkeypatch.setenv("SSL_CERT_DIR", str(tmp_path / "nonexistent"))
    n = fetch.download(server.url, tmp_path / "f", sha256=None, size=None, hosts=("127.0.0.1",), max_bytes=1000)
    assert n == len(BODY) and (tmp_path / "f").read_bytes() == BODY


def test_a_server_signed_by_nobody_trusted_is_refused(server, no_default_paths, tmp_path):
    with pytest.raises(fetch.ToolInstallError) as e:
        fetch.download(server.url, tmp_path / "f", sha256=None, size=None, hosts=("127.0.0.1",), max_bytes=1000)
    assert any(isinstance(c, ssl.SSLCertVerificationError) for c in _causes(e.value)), _causes(e.value)
    assert not (tmp_path / "f").exists()


def test_without_the_apps_list_the_default_context_is_used_with_one_warning(server, pki, monkeypatch, tmp_path, caplog):
    monkeypatch.setattr(fetch, "_ca_file", lambda: str(tmp_path / "missing" / "cacert.pem"))
    monkeypatch.setenv("SSL_CERT_FILE", str(pki["ca"]))
    monkeypatch.setenv("SSL_CERT_DIR", str(tmp_path / "nonexistent"))
    with caplog.at_level(logging.WARNING, logger="ao_worker.fetch"):
        ctx = fetch.tls_context()
    _verifies(ctx)
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1 and "missing" not in warnings[0].getMessage()
    # a download where the machine's store would have worked does not fail for that reason
    n = fetch.download(server.url, tmp_path / "f", sha256=None, size=None, hosts=("127.0.0.1",), max_bytes=1000)
    assert n == len(BODY)


def test_certifi_is_a_declared_dependency_pinned_exactly():
    import tomllib

    deps = tomllib.loads((Path(__file__).parent.parent / "pyproject.toml").read_text())["project"]["dependencies"]
    pins = [d for d in deps if d.split("==")[0].strip().lower() == "certifi"]
    assert len(pins) == 1 and "==" in pins[0], deps
