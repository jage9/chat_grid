from __future__ import annotations

from pathlib import Path
import tomllib

from pydantic import BaseModel, Field


class ServerConfigSection(BaseModel):
    bind_ip: str = "127.0.0.1"
    port: int = 8765


class NetworkConfigSection(BaseModel):
    max_message_bytes: int = Field(default=2_000_000, gt=0)
    allow_insecure_ws: bool = True


class TlsConfigSection(BaseModel):
    cert_file: str = ""
    key_file: str = ""


class LoggingConfigSection(BaseModel):
    level: str = "INFO"


class StorageConfigSection(BaseModel):
    state_file: str = "runtime/items.json"


class AppConfig(BaseModel):
    server: ServerConfigSection = ServerConfigSection()
    network: NetworkConfigSection = NetworkConfigSection()
    tls: TlsConfigSection = TlsConfigSection()
    logging: LoggingConfigSection = LoggingConfigSection()
    storage: StorageConfigSection = StorageConfigSection()


def load_config(path: Path | None) -> AppConfig:
    if path is None:
        return AppConfig()

    if not path.exists():
        raise FileNotFoundError(f"Config file not found: {path}")

    with path.open("rb") as fp:
        data = tomllib.load(fp)

    config = AppConfig.model_validate(data)

    cert = config.tls.cert_file.strip()
    key = config.tls.key_file.strip()

    if not config.network.allow_insecure_ws and (not cert or not key):
        raise ValueError(
            "TLS is required when network.allow_insecure_ws=false; set tls.cert_file and tls.key_file"
        )

    return config
