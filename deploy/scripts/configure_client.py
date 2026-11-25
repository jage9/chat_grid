"""Prepare per-grid web files from a built client and the selected server config."""

import argparse
import html
import json
import os
from pathlib import Path
import tomllib


def base_path(value: str) -> str:
    """Normalize the public mount to a same-origin directory URL."""
    value = value.strip().strip("/")
    if any(char in value for char in "\\?#") or any(
        segment in {".", ".."} for segment in value.split("/")
    ):
        raise ValueError(f"Invalid server.base_path: {value!r}")
    return f"/{value}/" if value else "/"


def php_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path)
    parser.add_argument("built_index", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--expected-base", default="")
    parser.add_argument("--session-check-host", help="Internal server hostname for a separate web container")
    args = parser.parse_args()

    with args.config.open("rb") as fp:
        server = tomllib.load(fp).get("server", {})
    mount = base_path(server.get("base_path", "/"))
    if args.expected_base and base_path(args.expected_base) != mount:
        parser.error(f"deploy path {args.expected_base!r} differs from server.base_path {mount!r} in {args.config}")

    index = args.built_index.read_text(encoding="utf-8")
    marker = '<base href="./">'
    if index.count(marker) != 1:
        parser.error("expected a portable client build with one relative HTML base")
    (args.output_dir / "index.html").write_text(
        index.replace(marker, f'<base href="{html.escape(mount, quote=True)}">'), encoding="utf-8"
    )
    # The browser supplies its usual defaults for branding fields omitted here.
    branding = {
        key: value for key, value in (
            ("gridName", server.get("grid_name")), ("welcomeMessage", server.get("welcome_message"))
        ) if isinstance(value, str) and value.strip()
    }
    (args.output_dir / "client_branding.json").write_text(json.dumps(branding) + "\n", encoding="utf-8")

    origin = os.environ.get("CHGRID_HOST_ORIGIN", "").strip()
    if origin:
        host = (args.session_check_host or server.get("bind_ip", "127.0.0.1")).strip()
        if host in {"", "0.0.0.0"}:
            host = "127.0.0.1"
        elif host == "::":
            host = "[::1]"
        elif ":" in host and not host.startswith("["):
            host = f"[{host}]"
        url = f"http://{host}:{int(server.get('port', 8765))}{mount}auth/session/check"
        (args.output_dir / "media_proxy.config.php").write_text(
            "<?php\nreturn array(\n"
            f"    'host_origin' => {php_string(origin)},\n"
            f"    'session_check_url' => {php_string(url)},\n);\n", encoding="utf-8"
        )
    print(mount)


if __name__ == "__main__":
    main()
