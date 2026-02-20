# Local Development

## Start Server

```bash
cd /home/jjm/code/chgrid/server
.venv/bin/python main.py --config config.toml --port 8765
```

## Start Client

```bash
cd /home/jjm/code/chgrid/client
npm run dev -- --host 0.0.0.0 --port 5173
```

Open: `http://localhost:5173`

## Quick Restarts

Server:
```bash
lsof -tiTCP:8765 -sTCP:LISTEN | xargs -r kill
cd /home/jjm/code/chgrid/server
nohup .venv/bin/python main.py --config config.toml --port 8765 > /tmp/chgrid-server.log 2>&1 &
```

Client:
```bash
lsof -tiTCP:5173 -sTCP:LISTEN | xargs -r kill
cd /home/jjm/code/chgrid/client
nohup npm run dev -- --host 0.0.0.0 --port 5173 > /tmp/chgrid-client.log 2>&1 &
```
