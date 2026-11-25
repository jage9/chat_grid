"""Check the web-to-server route without using an account or creating a session."""

from http.client import HTTPConnection
import os
from pathlib import Path
import tomllib

from configure_client import base_path


with Path("/grid/config.toml").open("rb") as source:
    mount = base_path(tomllib.load(source).get("server", {}).get("base_path", "/"))
connection = HTTPConnection("127.0.0.1", 80, timeout=3)
connection.request(
    "GET",
    mount + "auth/session/check",
    headers={"Origin": os.environ["CHGRID_HOST_ORIGIN"], "X-Chgrid-Auth-Client": "1"},
)
response = connection.getresponse()
raise SystemExit(0 if response.status == 401 and response.read() == b"missing session" else 1)
