"""Exercise the supported Compose install with real HTTP and WebSocket clients.

Run with the server's locked dependencies installed. Docker Engine and the Compose
plugin must be available. LiveKit credentials are fixtures, so this test verifies
credential delivery without connecting to a voice server.
"""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen

from websockets.sync.client import connect


ROOT = Path(__file__).resolve().parents[2]
PASSWORD = "compose-test-password"
PROJECT = "chgrid-test-" + secrets.token_hex(4)


def receive(connection, packet_type):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        packet = json.loads(
            connection.recv(timeout=max(0.1, deadline - time.monotonic()))
        )
        if packet["type"] == packet_type:
            return packet
    raise AssertionError(f"Did not receive {packet_type}")


def send(connection, packet_type, **fields):
    connection.send(json.dumps(dict(type=packet_type, **fields)))


@contextmanager
def login(origin, mount, username, register=False):
    with connect(
        origin.replace("http:", "ws:") + mount + "ws", origin=origin
    ) as connection:
        assert receive(connection, "auth_required")["gridName"] == "Compose test grid"
        send(
            connection,
            "auth_register" if register else "auth_login",
            username=username,
            password=PASSWORD,
        )
        auth = receive(connection, "auth_result")
        assert auth["ok"], auth
        welcome = receive(connection, "welcome")
        voice = receive(connection, "livekit_token")
        assert voice["token"] and voice["url"] == "wss://voice.example.test"
        send(connection, "welcome_ready")
        send(connection, "ping", clientSentAt=1)
        receive(connection, "pong")
        yield connection, auth, welcome


def request(url, expected=200, **headers):
    try:
        response = urlopen(Request(url, headers=headers), timeout=15)
    except HTTPError as error:
        response = error
    with response:
        body = response.read()
        assert response.status == expected, (url, response.status, body[:300])
        return body, response.headers


def run_mount(mount, build):
    with tempfile.TemporaryDirectory(prefix="chgrid-compose-") as temporary:
        instance = Path(temporary)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        origin = f"http://127.0.0.1:{port}"
        config = (ROOT / "deploy/docker/config.example.toml").read_text()
        config = config.replace('base_path = "/"', f'base_path = "{mount}"')
        config = config.replace(
            'grid_name = "Chat Grid"', 'grid_name = "Compose test grid"'
        )
        (instance / "config.toml").write_text(config)
        (instance / "data").mkdir()
        env_file = instance / ".env"
        settings = {
            "CHGRID_HOST_ORIGIN": origin,
            "CHGRID_AUTH_SECRET": secrets.token_hex(32),
            "LIVEKIT_URL": "wss://voice.example.test",
            "LIVEKIT_API_KEY": "compose-test",
            "LIVEKIT_API_SECRET": "compose-test-secret",
        }
        env_text = (ROOT / "deploy/docker/.env.example").read_text()
        for name, value in settings.items():
            env_text, count = re.subn(
                rf"^{name}=.*$", f"{name}={value}", env_text, flags=re.MULTILINE
            )
            assert count == 1, name
        env_file.write_text(env_text)
        environment = dict(
            os.environ,
            CHGRID_INSTANCE_DIR=str(instance),
            CHGRID_HTTP_PORT=str(port),
            CHGRID_UID=str(os.getuid()),
            CHGRID_GID=str(os.getgid()),
        )
        command = [
            "docker",
            "compose",
            "-f",
            str(ROOT / "compose.yaml"),
            "--env-file",
            str(env_file),
            "-p",
            PROJECT,
        ]

        def compose(*args, **kwargs):
            return subprocess.run(
                [*command, *args], cwd=ROOT, env=environment, check=True, **kwargs
            )

        try:
            if build:
                compose("build")
            compose(
                "run",
                "--rm",
                "-T",
                "server",
                "python",
                "main.py",
                "--config",
                "/grid/config.toml",
                "--bootstrap-admin",
                input=f"admin\n{PASSWORD}\n{PASSWORD}\n\n",
                text=True,
            )
            compose("up", "-d", "--wait", "--wait-timeout", "90")
            body, headers = request(origin + mount)
            index = body.decode()
            assert f'<base href="{mount}">' in index
            assert "no-store" in headers.get("Cache-Control", "")
            for reference in re.findall(
                r'<(?:script|link)\b[^>]*? (?:src|href)="([^"]+)"', index
            ):
                assert request(urljoin(origin + mount, reference))[0]
            branding = json.loads(request(origin + mount + "client_branding.json")[0])
            assert branding["gridName"] == "Compose test grid"
            for sound in ("default/step-1.ogg", "bridge/step-9.ogg"):
                assert (
                    request(origin + mount + "sounds/steps/" + sound)[0][:4] == b"OggS"
                )
            request(origin + mount + "media_proxy.php", expected=401, Origin=origin)

            with login(origin, mount, "admin") as (admin, auth, welcome):
                assert "world.platform.edit" in welcome["auth"]["permissions"]
                footstep_sets = {
                    entry["id"]: entry
                    for entry in welcome["worldConfig"]["footstepSets"]
                }
                assert len(footstep_sets["default"]["urls"]) == 11
                assert len(footstep_sets["bridge"]["urls"]) == 9
                assert welcome["worldConfig"]["ambianceTypes"]
                _, response_headers = request(
                    origin + mount + "auth/session/set",
                    Origin=origin,
                    Authorization="Bearer " + auth["sessionToken"],
                    **{"X-Chgrid-Auth-Client": "1"},
                )
                set_cookie = response_headers["Set-Cookie"]
                assert "HttpOnly" in set_cookie and f"Path={mount}" in set_cookie
                cookie = set_cookie.split(";", 1)[0]
                request(
                    origin + mount + "auth/session/check",
                    expected=204,
                    Origin=origin,
                    Cookie=cookie,
                    **{"X-Chgrid-Auth-Client": "1"},
                )
                body, _ = request(
                    origin + mount + "media_proxy.php",
                    expected=400,
                    Origin=origin,
                    Cookie=cookie,
                )
                assert b"missing url query param" in body
                sample = (
                    "https://raw.githubusercontent.com/jage9/chat_grid/"
                    "99e12d6c82f70a2766362688e7eeb6b5474ae7e0/"
                    "client/public/sounds/steps/default/step-1.ogg"
                )
                proxied, _ = request(
                    origin + mount + "media_proxy.php?url=" + quote(sample, safe=""),
                    Origin=origin,
                    Cookie=cookie,
                )
                assert (
                    proxied
                    == (
                        ROOT / "client/public/sounds/steps/default/step-1.ogg"
                    ).read_bytes()
                )
                request(
                    origin + mount + "media_proxy.php",
                    expected=403,
                    Origin="https://wrong.example",
                )

                with login(origin, mount, "visitor", register=True) as (visitor, _, _):
                    send(admin, "chat_message", message="Compose two-client test")
                    received = receive(visitor, "chat_message")
                    while received.get("message") != "Compose two-client test":
                        received = receive(visitor, "chat_message")
                    send(admin, "item_add", itemType="dice")
                    result = receive(admin, "item_action_result")
                    assert result["ok"], result
                    item_id = result["itemId"]
                    upsert = receive(visitor, "item_upsert")
                    assert upsert["item"]["id"] == item_id
                send(
                    admin,
                    "checkpoint_action",
                    action="capture",
                    label="Compose persistence",
                )
                assert receive(admin, "checkpoint_result")["ok"]

            compose("down", "--timeout", "20")
            compose("up", "-d", "--wait", "--wait-timeout", "90")
            with login(origin, mount, "admin") as (admin, _, welcome):
                assert item_id in {item["id"] for item in welcome["items"]}
                send(admin, "checkpoint_action", action="list")
                result = receive(admin, "checkpoint_result")
                assert result["ok"] and any(
                    c["label"] == "Compose persistence" for c in result["checkpoints"]
                )
            with login(origin, mount, "visitor"):
                pass
            assert (instance / "data/chatgrid.db").is_file()
            print(f"Compose smoke test passed at {mount}", flush=True)
        except Exception:
            subprocess.run(
                [*command, "logs", "--no-color", "--tail", "150"],
                cwd=ROOT,
                env=environment,
            )
            raise
        finally:
            subprocess.run(
                [*command, "down", "--timeout", "20"],
                cwd=ROOT,
                env=environment,
                check=True,
            )


if __name__ == "__main__":
    run_mount("/", build=True)
    run_mount("/ttgrid/", build=False)
