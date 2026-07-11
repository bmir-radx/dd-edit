# dd-edit

A desktop app for viewing and editing
[data dictionaries](https://github.com/bmir-radx/radx-data-dictionary-specification),
built around the efficiency of a spreadsheet — rows are data elements, columns
are the specification's fields — with live previews of the CSV and
[LinkML](https://linkml.io) YAML serializations and the rendered HTML page.
REDCap data dictionary exports import directly.

**Status: early development.** The [design](DESIGN.md) and the milestone-1
skeleton (Electron shell + Python sidecar handshake) are in place; the editor
itself is not built yet.

## Architecture in one paragraph

An Electron app (React + TypeScript) that owns the document — the toolkit's
canonical [dd-json](https://github.com/bmir-radx/radx-data-dictionary-specification/blob/main/api/dd_api/dd-json.schema.json)
representation — and a **stateless Python sidecar** (FastAPI on a random
localhost port) that wraps the released toolkit packages: `dd-api` for
conversions, `dd-validate` for findings, `dd-printer` for the HTML preview,
and `dd-redcap` for REDCap import. See [DESIGN.md](DESIGN.md).

## Development

Two one-time setups, then one command.

```sh
# 1. Python sidecar
cd sidecar
python -m venv .venv && .venv/bin/pip install -e ".[test]"
cd ..

# 2. Node app
npm install

# Run (spawns the sidecar automatically, opens the window with HMR)
npm run dev
```

Sidecar tests: `cd sidecar && .venv/bin/pytest`. Type checks: `npm run typecheck`.

## License

[BSD 2-Clause](LICENSE).
