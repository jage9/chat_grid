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
import sys
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
def login(
    origin, mount, username, register=False, forwarded_for=None, websocket_origin=None
):
    with connect(
        (websocket_origin or origin.replace("http:", "ws:")) + mount + "ws",
        origin=origin,
        additional_headers={"X-Forwarded-For": forwarded_for} if forwarded_for else {},
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


def check_trusted_logins(origin, mount):
    """Run from the trusted peer while retaining the public browser origin."""
    for admin_address, visitor_address in (
        ("198.51.100.21", "198.51.100.22"),
        ("198.51.100.23", "198.51.100.23"),
    ):
        with (
            login(
                origin,
                mount,
                "admin",
                forwarded_for=admin_address,
                websocket_origin="ws://web",
            ),
            login(
                origin,
                mount,
                "visitor",
                forwarded_for=visitor_address,
                websocket_origin="ws://web",
            ),
        ):
            pass


def check_proxy_addresses(compose, environment, origin, mount):
    """Use a known container peer to exercise the actual Apache trust boundary."""
    container = compose(
        "ps", "-q", "server", capture_output=True, text=True
    ).stdout.strip()
    details = json.loads(
        subprocess.check_output(["docker", "inspect", container], text=True)
    )[0]
    networks = details["NetworkSettings"]["Networks"]
    assert len(networks) == 1
    environment["CHGRID_TRUSTED_EDGE_PROXY"] = next(iter(networks.values()))[
        "IPAddress"
    ]
    compose("up", "-d", "--no-deps", "--force-recreate", "--wait", "web")
    compose(
        "exec",
        "-T",
        "server",
        "python",
        "-",
        "--trusted-proxy-clients",
        origin,
        mount,
        input=Path(__file__).read_text(),
        text=True,
    )
    # This request comes from the host, which isn't the configured trusted edge.
    with login(origin, mount, "admin", forwarded_for="198.51.100.99"):
        pass
    logs = compose(
        "logs", "--no-color", "--tail", "100", "server", capture_output=True, text=True
    ).stdout
    successes = re.findall(r"auth login success .* ip=(\S+) username=(\S+) ", logs)
    for address, username in (
        ("198.51.100.21", "admin"),
        ("198.51.100.22", "visitor"),
        ("198.51.100.23", "admin"),
        ("198.51.100.23", "visitor"),
    ):
        assert (address, username) in successes, successes
    assert not any(address == "198.51.100.99" for address, _ in successes), successes
    environment["CHGRID_TRUSTED_EDGE_PROXY"] = ""


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
            CHGRID_TRUSTED_EDGE_PROXY="",
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
                for name in ("default", "bridge"):
                    samples = (ROOT / "client/public/sounds/steps" / name).glob("*.ogg")
                    assert set(footstep_sets[name]["urls"]) == {
                        f"/sounds/steps/{name}/{sample.name}" for sample in samples
                    }
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
                assert proxied == request(sample)[0]
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

            if mount == "/ttgrid/":
                check_proxy_addresses(compose, environment, origin, mount)
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
    if len(sys.argv) > 1 and sys.argv[1] == "--trusted-proxy-clients":
        check_trusted_logins(*sys.argv[2:])
    else:
        run_mount("/", build=True)
        run_mount("/ttgrid/", build=False)
