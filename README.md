# dd-edit

A desktop app for viewing and editing
[data dictionaries](https://github.com/bmir-radx/radx-data-dictionary-specification),
built around the efficiency of a spreadsheet — rows are data elements, columns
are the specification's fields — with live previews of the CSV and
[LinkML](https://linkml.io) YAML serializations and the rendered HTML page.
REDCap data dictionary exports import directly.

![dd-edit editing a data dictionary: the spreadsheet grid with section colors, datatype pills, and enumerations on the left; the element inspector with precondition, unit, and ontology-term fields on the right](docs/screenshot.png)

**Status: working editor.** Milestones 1–4 of the [design](DESIGN.md) are in
place — the app opens, edits, validates, and saves real dictionaries:

- **Spreadsheet grid** ([Glide Data Grid](https://github.com/glideapps/glide-data-grid)):
  inline editing, fill handle, range selection, TSV copy/paste that
  interoperates with Excel/Sheets, row add/delete/drag-reorder, and undo/redo
  over the document model.
- **Element inspector**: structured editing of every field — a precondition
  editor with grammar type-ahead and a live read-back of the parsed
  expression, datatype/cardinality pickers, UCUM unit assistance,
  enumeration / missing-value / ontology-term editors (terms resolve their
  human-readable labels via OLS), and a Markdown description editor with
  preview.
- **Live previews**: the CSV (rendered as a table), the LinkML YAML, and the
  `dd-printer` HTML page, debounced as you type.
- **Validation**: `dd-validate` findings appear as cell tints and a problems
  panel; the CSV's line numbers map 1:1 onto grid rows.
- **REDCap import**, and open/save across all three toolkit formats
  (CSV / LinkML YAML / dd-json).
- **Installers** (milestone 5): `npm run dist` produces a macOS app with the
  Python sidecar bundled inside — see [Packaging](#packaging).

The LinkML preview can be scoped to the selected element — handy for checking
how one field renders without scrolling the whole schema:

![The LinkML preview pane showing the generated schema for just the selected data element](docs/screenshot-linkml.png)

Still on the list: in-grid enumeration editing and collapsible section groups.

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

Sidecar tests: `cd sidecar && .venv/bin/pytest`. Renderer tests: `npm test`.
Type checks: `npm run typecheck`. CI runs all three on every push.

## Packaging

```sh
# one-time: PyInstaller into the sidecar venv
cd sidecar && .venv/bin/pip install -e ".[build]" && cd ..

npm run dist
```

`npm run dist` builds the app bundles, the PyInstaller one-dir sidecar
(`sidecar/build-binary.sh`), and unsigned macOS installers (DMG + zip) in
`release/`. The sidecar ships inside the app as an extra resource and is
spawned from there when the app is packaged; builds are unsigned for now, so
the first launch needs right-click → Open to satisfy Gatekeeper.

## License

[BSD 2-Clause](LICENSE).
