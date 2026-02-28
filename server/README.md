# chgrid signaling server

## Config

Copy `config.example.toml` to `config.toml` and set values.

```bash
cd server
cp config.example.toml config.toml
```

Key options:
- `server.bind_ip`, `server.port`
- `network.max_message_bytes`
- `network.allow_insecure_ws`
- `tls.cert_file`, `tls.key_file`

If `network.allow_insecure_ws = false`, TLS cert/key are required and server runs as `wss://`.
For local/dev without TLS, either set `network.allow_insecure_ws = true` or pass `--allow-insecure-ws`.

## Run

```bash
cd server
python -m venv .venv
source .venv/bin/activate
pip install -e .[dev]
python main.py --config config.toml
```

## CLI overrides

```bash
python main.py --config config.toml --host 127.0.0.1 --port 8765
python main.py --config config.toml --allow-insecure-ws
python main.py --config config.toml --ssl-cert /path/cert.pem --ssl-key /path/key.pem
```
