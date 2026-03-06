"""
Entry point for running the Kickflip parser on Windows (or any platform).

Use this instead of invoking uvicorn directly when running on Windows:

    python run.py                        # default: 0.0.0.0:8000
    python run.py --host 127.0.0.1 --port 8080
    python run.py --reload               # hot-reload for development

Why this file exists
────────────────────
Playwright spawns Chromium as a subprocess. On Windows, asyncio's default
SelectorEventLoop does NOT support subprocess transports and raises
NotImplementedError inside Playwright's Connection.run().

The WindowsProactorEventLoopPolicy must be set BEFORE uvicorn creates its
event loop.  Placing it here (before uvicorn is imported) guarantees correct
ordering on all Windows Python distributions.

On Linux / macOS this file is still usable — the Windows-specific block is
a no-op on those platforms.
"""
from __future__ import annotations

import argparse
import sys

# ── Windows: ProactorEventLoop required by Playwright ────────────────────────
if sys.platform == "win32":
    import asyncio
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
# ─────────────────────────────────────────────────────────────────────────────

import uvicorn


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run the Kickflip event parser server.")
    p.add_argument("--host", default="0.0.0.0", help="Bind host (default: 0.0.0.0)")
    p.add_argument("--port", type=int, default=8000, help="Bind port (default: 8000)")
    p.add_argument(
        "--reload",
        action="store_true",
        default=False,
        help="Enable hot-reload (development only; incompatible with ProactorEventLoop)",
    )
    p.add_argument(
        "--log-level",
        default="info",
        choices=["debug", "info", "warning", "error", "critical"],
        help="Uvicorn log level (default: info)",
    )
    return p.parse_args()


if __name__ == "__main__":
    args = _parse_args()

    # Note: --reload forks worker processes which creates a new event loop in
    # each worker.  The policy set above covers the main process; child
    # processes inherit it through the policy module-level state.
    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level=args.log_level,
        # Explicitly request the asyncio loop (ProactorEventLoop on Windows).
        # "uvloop" is not available on Windows, so this is safe cross-platform.
        loop="asyncio",
    )
