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

Set `storage.data_dir` to the directory containing the grid's `items.json`,
world files, checkpoint history, and `chatgrid.db`. It defaults to `runtime`
beside the selected config. An explicit `storage.state_file` or `auth.db_file`
overrides the corresponding file path. Relative paths in all three settings
start at the config directory. World files and checkpoints follow the items
file when its path is overridden.

`world.grid_size` sets the width and length of the starter platforms and defaults to 41.

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


## Manual world checkpoints

With persistent world storage configured, administrators can capture, browse, and restore from World Builder. Grant `world.checkpoint.capture` to builders who need to save checkpoints, `world.checkpoint.view` to those who need previews, and both view and `world.checkpoint.restore` to operators who may replace the live grid. Accounts, roles, sessions, and personal preferences are outside the captured world.

The server writes checkpoints to `world-checkpoints/` beside the configured item state file. Each restore also saves a **Before restore** checkpoint. A complete restored generation is staged under `world-generations/` before switching `world-generations/current.json`. Later saves and restarts use that generation. Include both directories when backing up the state directory, and protect them like the live world files because they include door lock verifiers. Checkpoint browsing and preview are read-only. Manual checkpoints remain on disk until an operator manages their retention.
