"""Run the sidecar: ``python -m dd_edit_sidecar --port N``.

Binds to 127.0.0.1 only — the sidecar exists solely for the local dd-edit app.
"""

from __future__ import annotations

import argparse

import uvicorn

from .app import app


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="dd-edit-sidecar")
    parser.add_argument("--port", type=int, default=8756)
    args = parser.parse_args(argv)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
