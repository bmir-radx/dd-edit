# dd-edit

A desktop app for viewing and editing
[data dictionaries](https://github.com/bmir-radx/radx-data-dictionary-specification),
built around the efficiency of a spreadsheet — rows are data elements, columns
are the specification's fields — with live previews of the CSV and
[LinkML](https://linkml.io) YAML serializations and the rendered HTML page.
REDCap data dictionary exports import directly.

![dd-edit editing a data dictionary: the spreadsheet grid with section colors, datatype pills, and enumerations on the left; the element inspector with precondition, unit, and ontology-term fields on the right](docs/screenshot.png)

## Getting the app

There are no published releases yet: build the macOS app yourself with
`npm run dist` (see [Packaging](#packaging)) and open the DMG it leaves in
`release/`, or run from source (see [Development](#development)).

## Opening a dictionary

dd-edit opens data dictionaries saved as CSV, LinkML YAML, or dd-json —
use **Open…** (⌘O) or the buttons on the welcome screen. REDCap data
dictionary exports open too: they are brought in as an import (the title
shows, say, `study.csv (imported)`), and saving writes a standard data
dictionary, since REDCap's own format can't express everything the
specification can.

## Editing in the grid

The grid works the way a spreadsheet does. Click a cell to edit it in place,
copy and paste ranges to and from Excel or Google Sheets, drag the fill
handle to repeat a value down a column, and drag rows to reorder them. Add an
element with the row at the bottom of the grid; undo and redo work for every
change (⌘Z / ⇧⌘Z).

The grid also lends a hand where it can. When something has an easy fix — a
unit written informally where a standard code exists, or an enumeration whose
values are all integers while the datatype says `string` — an amber
suggestion appears right in the cell; click it to apply the fix (datatype
changes ask for confirmation first).

## The element inspector

Select a row and the panel on the right shows everything about that element.
Highlights:

- **Precondition** — write conditions like `consented = "1" and age >= 18`;
  the field suggests what can come next as you type and shows a plain
  reading of the condition underneath.
- **Unit** — type a unit and the standard [UCUM](https://ucum.org) code is
  suggested (for example "years" → `a`); free text remains allowed.
- **Enumerations and missing-value codes** — edit each permissible value
  with its label, optionally linked to an ontology term.
- **Ontology terms** — paste an IRI or an OBO id such as `MONDO:0004979` and
  the term's human-readable name appears, with a link out to browse it.
- **Description** — written in Markdown, shown formatted.

## Previews

The CSV, LinkML, and HTML tabs show the dictionary exactly as it will be
written out — as a table, as a LinkML schema, and as a formatted web page —
and they update as you type. Selecting rows in the grid scopes the LinkML
preview to just those elements, which is handy for checking how one field
renders without scrolling the whole schema:

![The LinkML preview pane showing the generated schema for just the selected data element](docs/screenshot-linkml.png)

## Checking your dictionary

The Problems tab lists everything the specification's validator finds in the
open dictionary, and each problem highlights its cell in the grid. Line
numbers match the saved CSV line for line, so a problem reported against the
file is easy to trace back to a row.

## What's not there yet

Enumerations are edited in the inspector (not yet directly in the grid), and
sections can't yet be collapsed into groups. The [design](DESIGN.md) has the
full roadmap.

## Development

The app is two processes: the Electron/React editor owns the document, and a
stateless Python sidecar (FastAPI, localhost) wraps the released toolkit
packages for conversion, validation, rendering, and REDCap import — see
[DESIGN.md](DESIGN.md) for the full picture. Hence two one-time setups, then
one command.

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

## Acknowledgements

dd-edit stands on:

- [Glide Data Grid](https://github.com/glideapps/glide-data-grid) — the
  canvas-based spreadsheet grid at the heart of the editor.
- [Electron](https://www.electronjs.org),
  [electron-vite](https://electron-vite.org),
  [electron-builder](https://www.electron.build),
  [React](https://react.dev), and [Zustand](https://zustand-demo.pmnd.rs) —
  the app shell, tooling, and state.
- [FastAPI](https://fastapi.tiangolo.com) and
  [Uvicorn](https://www.uvicorn.org) — the Python sidecar — bundled for
  distribution with [PyInstaller](https://pyinstaller.org).
- [LinkML](https://linkml.io) — the schema language the toolkit renders
  dictionaries into.
- [marked](https://marked.js.org) — Markdown rendering for descriptions.
- [EMBL-EBI OLS4](https://www.ebi.ac.uk/ols4/) and
  [BioPortal](https://bioportal.bioontology.org) — ontology term label
  lookups.
- [UCUM](https://ucum.org) — the unit vocabulary behind the Unit field's
  assistance.
