"""Publish a single production build at three mounts and fetch its public files."""

from functools import partial
from hashlib import sha256
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from urllib.parse import urljoin
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "client" / "dist"
DEPLOY = ROOT / "deploy" / "scripts" / "deploy_client.sh"


def hashes(directory):
    return {
        path.relative_to(directory): sha256(path.read_bytes()).digest()
        for path in directory.rglob("*") if path.is_file()
    }


class PortablePublishTests(unittest.TestCase):
    def test_one_build_at_three_mounts(self):
        with TemporaryDirectory() as temp:
            fixture = Path(temp)
            (fixture / "client").mkdir()
            (fixture / "server").mkdir()
            (fixture / "deploy").symlink_to(ROOT / "deploy", target_is_directory=True)
            config = fixture / "server" / "grid.toml"
            env = dict(os.environ, CHGRID_CLIENT_DIST=str(DIST), CHGRID_HOST_ORIGIN="https://grid.example")
            built = hashes(DIST)
            self.assertIn(Path("version.js"), built)

            for mount in ("/", "/chgrid/", "/ttgrid/"):
                with self.subTest(mount=mount):
                    docroot = fixture / ("site-" + mount.strip("/"))
                    publish = docroot / mount.strip("/")
                    config.write_text(
                        f'[server]\nbase_path = "{mount}"\nport = 18765\ngrid_name = "Grid at {mount}"\n',
                        encoding="utf-8",
                    )
                    command = ["bash", str(DEPLOY), str(fixture), str(publish)]
                    subprocess.run([*command, mount, str(config)], check=True, env=env)
                    published = hashes(publish)
                    for path, digest in built.items():
                        if path.name not in {"index.html", "client_branding.json"}:
                            self.assertEqual(published[path], digest, path)
                    self.assertIn(
                        f"http://127.0.0.1:18765{mount}auth/session/check",
                        (publish / "media_proxy.config.php").read_text(),
                    )
                    self.check_served_site(docroot, mount)

                    mismatch = subprocess.run(
                        [*command, "/wrong/", str(config)], env=env, capture_output=True, text=True
                    )
                    self.assertNotEqual(mismatch.returncode, 0)
                    self.assertIn("differs from server.base_path", mismatch.stderr)
                    self.assertEqual(hashes(publish), published)

            self.assertEqual(hashes(DIST), built)

    def check_served_site(self, docroot, mount):
        handler = partial(SimpleHTTPRequestHandler, directory=str(docroot))
        with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                origin = f"http://127.0.0.1:{server.server_port}"
                with urlopen(origin + mount) as response:
                    index = response.read().decode()
                self.assertIn(f'<base href="{mount}">', index)
                refs = re.findall(r'<(?:script|link)\b[^>]*? (?:src|href)="([^"]+)"', index)
                self.assertIn("./version.js", refs)
                for ref in [*refs, "sounds/logon.ogg", "media_proxy.php", "client_branding.json"]:
                    url = urljoin(origin + mount, ref)
                    self.assertTrue(url.startswith(origin + mount), ref)
                    with urlopen(url) as response:
                        body = response.read()
                    self.assertTrue(body, ref)
                    if ref == "client_branding.json":
                        self.assertEqual(json.loads(body)["gridName"], f"Grid at {mount}")
            finally:
                server.shutdown()
                worker.join()


if __name__ == "__main__":
    unittest.main()
