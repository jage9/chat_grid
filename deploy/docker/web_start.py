"""Publish the portable client and configure its internal Compose proxy routes."""

import os
from pathlib import Path
import re
import shutil
import subprocess
import tomllib
from urllib.parse import urlsplit

from configure_client import base_path


def apache_config(mount: str, port: int, scheme: str) -> str:
    """Build Apache directives from a validated URL mount, port and scheme."""
    if not re.fullmatch(r"/(?:[A-Za-z0-9._~-]+/)*", mount):
        raise ValueError("Docker server.base_path must contain URL-safe path segments")
    if not 1 <= port <= 65535:
        raise ValueError("server.port must be between 1 and 65535")
    if scheme not in {"http", "https"}:
        raise ValueError("CHGRID_HOST_ORIGIN must use http or https")
    document_root = "/var/www/html" if mount == "/" else "/var/www/empty"
    alias = ""
    if mount != "/":
        alias = (
            f'    Alias "{mount}" "/var/www/html/"\n'
            f'    RedirectMatch 308 "^{re.escape(mount[:-1])}$" "{mount}"\n'
        )
    return f"""ServerName localhost
<VirtualHost *:80>
    DocumentRoot "{document_root}"
    ProxyRequests Off
    ProxyPreserveHost On
    RequestHeader set X-Forwarded-Proto "{scheme}"
    ProxyPass "{mount}ws" "ws://server:{port}{mount}ws"
    ProxyPassReverse "{mount}ws" "ws://server:{port}{mount}ws"
    ProxyPass "{mount}auth/session/" "http://server:{port}{mount}auth/session/"
    ProxyPassReverse "{mount}auth/session/" "http://server:{port}{mount}auth/session/"
{alias}    <Directory "/var/www/html">
        Options -Indexes
        AllowOverride None
        Require all granted
        <FilesMatch "^(index\\.html|version\\.js|client_branding\\.json)$">
            Header set Cache-Control "no-store"
        </FilesMatch>
    </Directory>
    ErrorLog /proc/self/fd/2
    CustomLog /proc/self/fd/1 combined
</VirtualHost>
"""


def main() -> None:
    """Render the mounted site before replacing this process with Apache."""
    config = Path("/grid/config.toml")
    with config.open("rb") as source:
        server = tomllib.load(source).get("server", {})
    mount = base_path(server.get("base_path", "/"))
    port = server.get("port", 8765)
    origin = urlsplit(os.environ.get("CHGRID_HOST_ORIGIN", ""))
    if (
        not origin.hostname
        or origin.username is not None
        or origin.password is not None
        or origin.path not in {"", "/"}
        or origin.query
        or origin.fragment
    ):
        raise ValueError("CHGRID_HOST_ORIGIN must be the public origin, such as https://grid.example.com")
    apache = apache_config(mount, port, origin.scheme)
    destination = Path("/var/www/html")
    shutil.copytree("/opt/chgrid/client", destination, dirs_exist_ok=True)
    subprocess.run(
        [
            "python3", "/opt/chgrid/configure_client.py", str(config),
            "/opt/chgrid/client/index.html", str(destination),
            "--session-check-host", "server",
        ],
        check=True,
    )
    Path("/etc/apache2/sites-enabled/000-default.conf").write_text(apache, encoding="utf-8")
    subprocess.run(["apache2ctl", "configtest"], check=True)
    os.execvp("apache2-foreground", ["apache2-foreground"])


if __name__ == "__main__":
    main()
