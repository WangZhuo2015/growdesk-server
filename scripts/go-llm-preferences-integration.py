#!/usr/bin/env python3
"""Verify Go LLM preference persistence over real HTTP and an OS restart.

Run with an explicit env -i allowlist. The existing OwnedEnvironment from
scripts/go-integration.py supplies a disposable PostgreSQL/Redis pair; no
provider is contacted and no test credentials leave this process.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor


DEFAULT_ROOT = Path(__file__).resolve().parents[1]
ROOT = DEFAULT_ROOT
ALLOWED_ENV = {
    "PATH", "HOME", "GOCACHE", "GOPATH", "GOMODCACHE", "TMPDIR", "LC_CTYPE",
    "GOPROXY", "GOSUMDB", "GOENV", "GOTOOLCHAIN", "DOCKER_CONFIG",
}


def require_clean_environment() -> None:
    unexpected = set(os.environ) - ALLOWED_ENV
    if unexpected:
        raise RuntimeError("run this integration with an explicit env -i allowlist")
    if not os.environ.get("PATH"):
        raise RuntimeError("PATH is required")


def load_owned_environment_class(root: Path):
    spec = importlib.util.spec_from_file_location(
        "growdesk_owned_go_integration", root / "scripts/go-integration.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load existing OwnedEnvironment")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.OwnedEnvironment


def request(base: str, method: str, path: str, body=None, token=None):
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def expect(base: str, method: str, path: str, status: int, body=None, token=None):
    code, payload = request(base, method, path, body, token)
    if code != status:
        error = payload.get("error", {}) if isinstance(payload, dict) else {}
        safe_code = error.get("code", "unexpected_success") if isinstance(error, dict) else "invalid_error"
        raise AssertionError(f"{method} {path}: expected {status}, got {code} ({safe_code})")
    return payload


def b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def sign_wrong_audience_token(jwt_secret: str, subject: str, session_id: str) -> str:
    now = int(time.time())
    header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = {
        "sub": subject,
        "sid": session_id,
        "deviceLabel": "test_integration",
        "typ": "at+jwt",
        "iss": "growdesk-api",
        "aud": "http://127.0.0.1/mcp",
        "iat": now,
        "exp": now + 300,
        "jti": secrets.token_hex(16),
    }
    encoded_claims = b64url(json.dumps(claims, separators=(",", ":")).encode())
    message = f"{header}.{encoded_claims}".encode("ascii")
    signature = hmac.new(jwt_secret.encode(), message, hashlib.sha256).digest()
    return f"{message.decode('ascii')}.{b64url(signature)}"


def reserve_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    if port in (3088, 3089, 5432, 6379):
        raise RuntimeError("ephemeral port collided with a protected service port")
    return port


def start_go_process(owned, binary: Path) -> tuple[str, subprocess.Popen, int]:
    port = reserve_port()
    log = tempfile.TemporaryFile(mode="w+t")
    owned.files.append(log)
    proc = subprocess.Popen(
        [str(binary.resolve())],
        cwd=ROOT,
        env={**owned.env, "PORT": str(port)},
        stdout=log,
        stderr=log,
    )
    owned.processes.append(proc)
    base = f"http://127.0.0.1:{port}"
    for _ in range(150):
        if proc.poll() is not None:
            raise RuntimeError(f"Go API exited before ready (exit={proc.returncode})")
        try:
            status, _ = request(base, "GET", "/health/ready")
            if status == 200:
                return base, proc, port
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.1)
    raise RuntimeError("Go API readiness timed out")


def stop_go_process(proc: subprocess.Popen) -> None:
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
    try:
        exit_code = proc.wait(timeout=25)
    except subprocess.TimeoutExpired as error:
        proc.kill()
        proc.wait(timeout=5)
        raise RuntimeError("Go API did not stop after SIGTERM") from error
    if exit_code != 0:
        raise RuntimeError(f"Go API stopped with exit={exit_code}")


def verify_owned_cleanup(owned) -> None:
    result = subprocess.run(
        ["docker", "ps", "-a", "--filter", f"label=growdesk.test.owner={owned.owner}", "--format", "{{.ID}}"],
        env=owned.env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("could not verify owned container cleanup")
    if result.stdout.strip():
        raise RuntimeError("owned test containers remain after cleanup")


def register(base: str, label: str, stamp: str):
    username = f"test_llm_preferences_{label}_{stamp}"
    display_name = f"test_llm_preferences_{label}_{stamp}"
    password = "test_password_llm_preferences_" + secrets.token_hex(12)
    payload = {
        "username": username,
        "password": password,
        "displayName": display_name,
        "deviceLabel": "test_integration",
    }
    result = expect(base, "POST", "/api/v1/auth/register", 201, payload)["data"]
    return result


def preference_tests(base: str, owned, stamp: str):
    path = "/api/v1/web/ai/preferences"
    expect(base, "GET", path, 401)
    expect(base, "PUT", path, 401, {
        "feature": "chat", "source": "api", "profileId": "test_profile", "modelId": "test_model"
    })

    user_a = register(base, "a", stamp)
    user_b = register(base, "b", stamp)
    token_a, token_b = user_a["accessToken"], user_b["accessToken"]
    expected = [
        {"feature": "chat", "source": "api", "profileId": "test_profile_chat", "modelId": "test_model_chat"},
        {"feature": "daily_summary", "source": "chatgpt", "profileId": "test_profile_daily", "modelId": "test_model_daily"},
        {"feature": "tips", "source": "api", "profileId": "test_profile_tips", "modelId": "test_model_tips"},
        {"feature": "voice", "source": "chatgpt", "profileId": "test_profile_voice", "modelId": "test_model_voice"},
        {"feature": "medical_ocr", "source": "api", "profileId": "test_profile_ocr", "modelId": "test_model_ocr"},
    ]

    def save(value):
        return expect(base, "PUT", path, 200, value, token_a)["data"]

    with ThreadPoolExecutor(max_workers=len(expected)) as pool:
        saved = list(pool.map(save, expected))
    if sorted(saved, key=lambda item: item["feature"]) != sorted(expected, key=lambda item: item["feature"]):
        raise AssertionError("concurrent preference writes did not preserve their independent selections")

    initial_b = expect(base, "GET", path, 200, token=token_b)["data"]["preferences"]
    if initial_b:
        raise AssertionError("new second user saw another tenant's preferences")
    b_chat = {"feature": "chat", "source": "api", "profileId": "test_profile_b", "modelId": "test_model_b"}
    expect(base, "PUT", path, 200, b_chat, token_b)
    a_before_restart = expect(base, "GET", path, 200, token=token_a)["data"]["preferences"]
    b_before_restart = expect(base, "GET", path, 200, token=token_b)["data"]["preferences"]
    if sorted(a_before_restart, key=lambda item: item["feature"]) != sorted(expected, key=lambda item: item["feature"]):
        raise AssertionError("user A's per-feature selections were lost or overwritten")
    if b_before_restart != [b_chat]:
        raise AssertionError("user B's selection was not isolated")

    forged_owner = {**expected[0], "userId": user_b["user"]["id"]}
    expect(base, "PUT", path, 400, forged_owner, token_a)
    provider_fields = {
        **expected[0], "apiKey": "test_private_key", "baseUrl": "https://invalid.test",
        "headers": {"authorization": "test_private_key"},
    }
    expect(base, "PUT", path, 400, provider_fields, token_a)
    expect(base, "PUT", path, 400, {**expected[0], "ownerUserId": user_b["user"]["id"]}, token_a)

    wrong_audience = sign_wrong_audience_token(owned.jwt, user_a["user"]["id"], user_a["sessionId"])
    expect(base, "GET", path, 401, token=wrong_audience)
    expect(base, "PUT", path, 401, {**expected[0], "feature": "search"}, token=wrong_audience)
    print("PASS real Go HTTP: authenticated user isolation and MCP audience rejection", flush=True)
    print("PASS five independent selections saved concurrently: chat, daily_summary, tips, voice, medical_ocr", flush=True)
    print("PASS forged owner and provider credential/endpoint fields rejected", flush=True)
    return token_a, token_b, expected, b_chat


def restart_readback(base: str, token_a: str, token_b: str, expected, b_chat) -> None:
    path = "/api/v1/web/ai/preferences"
    a_values = expect(base, "GET", path, 200, token=token_a)["data"]["preferences"]
    b_values = expect(base, "GET", path, 200, token=token_b)["data"]["preferences"]
    if sorted(a_values, key=lambda item: item["feature"]) != sorted(expected, key=lambda item: item["feature"]):
        raise AssertionError("user A's selections changed across the Go process restart")
    if b_values != [b_chat]:
        raise AssertionError("user B's selection changed across the Go process restart")


def parse_root() -> Path:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=DEFAULT_ROOT,
        help="source candidate root; binary and migrations are both taken from this directory",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    required = [
        root / "go.mod",
        root / "cmd/growdesk-api",
        root / "scripts/go-integration.py",
        root / "prisma/migrations",
    ]
    if any(not path.exists() for path in required):
        raise RuntimeError("--root must contain Go API source, OwnedEnvironment, and migrations")
    if root != DEFAULT_ROOT.resolve():
        manifest_path = root / "manifest.json"
        if not manifest_path.is_file():
            raise RuntimeError("explicit --root must be a staged candidate with manifest.json")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if Path(str(manifest.get("candidate", ""))).resolve() != root:
            raise RuntimeError("candidate manifest root does not match --root")
    return root


def main() -> int:
    global ROOT
    ROOT = parse_root()
    stage = "environment"
    owned = None
    temp_dir = None
    exit_code = 1
    try:
        require_clean_environment()
        for name in ("HOME", "GOCACHE", "GOPATH", "GOMODCACHE", "TMPDIR", "DOCKER_CONFIG"):
            value = os.environ.get(name)
            if value:
                Path(value).mkdir(parents=True, exist_ok=True)

        stage = "build"
        build_dir = Path(tempfile.mkdtemp(prefix="growdesk-llm-preferences-build-", dir="/tmp"))
        temp_dir = build_dir
        binary = build_dir / "growdesk-api"
        build_env = {key: os.environ[key] for key in ALLOWED_ENV if key in os.environ}
        build = subprocess.run(
            ["go", "build", "-trimpath", "-o", str(binary), "./cmd/growdesk-api"],
            cwd=ROOT,
            env=build_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        if build.returncode != 0:
            raise RuntimeError(f"Go API build failed (exit={build.returncode})")
        print(f"PASS Go API build from selected source root: {ROOT}", flush=True)

        stage = "owned PostgreSQL/Redis"
        OwnedEnvironment = load_owned_environment_class(ROOT)
        owned = OwnedEnvironment()
        owned.start()
        stage = "Go API process and HTTP assertions"
        base, proc, _ = start_go_process(owned, binary)
        stamp = f"{int(time.time())}_{secrets.token_hex(4)}"
        token_a, token_b, expected, b_chat = preference_tests(base, owned, stamp)

        stage = "Go OS process restart"
        stop_go_process(proc)
        if proc.poll() is None:
            raise AssertionError("old Go API process remained alive after SIGTERM")
        print("PASS old Go API OS process stopped cleanly", flush=True)
        restarted_base, _, _ = start_go_process(owned, binary)
        restart_readback(restarted_base, token_a, token_b, expected, b_chat)
        print("PASS fresh Go API OS process read back persisted per-user selections", flush=True)
        print("PASS no model provider calls; only test profile/model identifiers were persisted", flush=True)
        exit_code = 0
    except (AssertionError, RuntimeError) as error:
        print(f"FAIL stage={stage} error={str(error)}", file=sys.stderr, flush=True)
    except Exception as error:
        # Avoid printing subprocess arguments or infrastructure exception text,
        # which can contain the disposable database password.
        print(f"FAIL stage={stage} error={type(error).__name__}", file=sys.stderr, flush=True)
    finally:
        if owned is not None:
            try:
                owned.close()
                verify_owned_cleanup(owned)
                print("PASS owned PostgreSQL/Redis containers removed; test tenant discarded", flush=True)
            except Exception as error:
                print(f"FAIL cleanup error={type(error).__name__}", file=sys.stderr, flush=True)
                exit_code = 1
        if temp_dir is not None:
            try:
                import shutil
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception:
                exit_code = 1
    print(f"Owned Go LLM preferences integration exit={exit_code}", flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
