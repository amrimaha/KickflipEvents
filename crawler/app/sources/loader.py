"""
Load source configurations from YAML or JSON files.

Lookup order:
  1. Path from settings.sources_file (default: sources.yaml)
  2. Tries .yaml → .json → .csv (comma-separated, minimal)
"""
from __future__ import annotations

import csv
import json
import os
from pathlib import Path
from typing import Union

import yaml

from app.models.source import SourceConfig
from app.utils.logger import BoundLogger

log = BoundLogger("kickflip.sources")


def _load_raw(path: Path) -> list[dict]:
    """Load raw dicts from YAML, JSON, or CSV."""
    suffix = path.suffix.lower()

    if suffix in (".yaml", ".yml"):
        with path.open("r", encoding="utf-8") as fh:
            data = yaml.safe_load(fh)
        if isinstance(data, dict) and "sources" in data:
            return data["sources"]
        if isinstance(data, list):
            return data
        raise ValueError(f"Unexpected YAML structure in {path}")

    if suffix == ".json":
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and "sources" in data:
            return data["sources"]
        if isinstance(data, list):
            return data
        raise ValueError(f"Unexpected JSON structure in {path}")

    if suffix == ".csv":
        rows = []
        with path.open("r", encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                # CSV: listing_urls is semicolon-separated
                if "listing_urls" in row and row["listing_urls"]:
                    row["listing_urls"] = [u.strip() for u in row["listing_urls"].split(";") if u.strip()]
                rows.append(row)
        return rows

    raise ValueError(f"Unsupported sources file format: {suffix}")


def _resolve_path(sources_file: str) -> Path:
    """Try the given path, then common extensions."""
    base = Path(sources_file)
    if base.exists():
        return base

    stem = base.stem
    parent = base.parent
    for ext in (".yaml", ".yml", ".json", ".csv"):
        candidate = parent / (stem + ext)
        if candidate.exists():
            return candidate

    raise FileNotFoundError(
        f"Sources file not found: tried '{sources_file}' and common extensions."
    )


def load_sources(sources_file: str = "sources.yaml") -> list[SourceConfig]:
    """
    Load and validate all source configurations.
    Logs a warning for any invalid entry and continues.
    """
    path = _resolve_path(sources_file)
    log.info("Loading sources", stage="source_start", url=str(path))

    raw_list = _load_raw(path)
    sources: list[SourceConfig] = []

    for i, raw in enumerate(raw_list):
        try:
            src = SourceConfig.model_validate(raw)
            if src.enabled:
                sources.append(src)
            else:
                log.info(
                    f"Skipping disabled source: {src.name}",
                    stage="source_start",
                )
        except Exception as exc:
            log.warning(
                f"Skipping invalid source at index {i}: {exc}",
                stage="source_start",
                extra={"raw": raw},
            )

    log.info(f"Loaded {len(sources)} enabled sources", stage="source_start")
    return sources
