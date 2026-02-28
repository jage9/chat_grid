"""Configuration models and loader for the signaling server."""

from __future__ import annotations

from pathlib import Path
import tomllib

from pydantic import BaseModel, Field


class ServerConfigSection(BaseModel):
    """Bind address and port options for websocket serving."""

    bind_ip: str = "127.0.0.1"
    port: int = 8765


class NetworkConfigSection(BaseModel):
    """Network transport and safety limits."""

    max_message_bytes: int = Field(default=2_000_000, gt=0)
    allow_insecure_ws: bool = False


class TlsConfigSection(BaseModel):
    """TLS certificate/key file configuration."""

    cert_file: str = ""
    key_file: str = ""


class LoggingConfigSection(BaseModel):
    """Runtime logging verbosity options."""

    level: str = "INFO"


class StorageConfigSection(BaseModel):
    """Persistent state file location."""

    state_file: str = "runtime/items.json"
    state_save_debounce_ms: int = Field(default=200, gt=0)
    state_save_max_delay_ms: int = Field(default=1000, gt=0)


class WorldConfigSection(BaseModel):
    """Authoritative world geometry options."""

    grid_size: int = Field(default=41, ge=1)


class AuthConfigSection(BaseModel):
    """Authentication persistence and validation settings."""

    db_file: str = "runtime/chatgrid.db"
    password_min_length: int = Field(default=8, ge=1)
    password_max_length: int = Field(default=32, ge=1)
    username_min_length: int = Field(default=2, ge=1)
    username_max_length: int = Field(default=32, ge=1)


class AppConfig(BaseModel):
    """Top-level application configuration document."""

    server: ServerConfigSection = ServerConfigSection()
    network: NetworkConfigSection = NetworkConfigSection()
    tls: TlsConfigSection = TlsConfigSection()
    logging: LoggingConfigSection = LoggingConfigSection()
    storage: StorageConfigSection = StorageConfigSection()
    world: WorldConfigSection = WorldConfigSection()
    auth: AuthConfigSection = AuthConfigSection()


def load_config(path: Path | None) -> AppConfig:
    """Load and validate config TOML, applying defaults and TLS checks."""

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
