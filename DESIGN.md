# dd-edit — design

A desktop app for viewing and editing [data
dictionaries](https://github.com/bmir-radx/radx-data-dictionary-specification),
built around the efficiency of a spreadsheet: rows are data elements, columns
are the specification's fields, and everything is keyboard-first. Live previews
show the CSV and LinkML YAML serializations (and the rendered HTML page) as you
edit. REDCap data dictionary exports can be imported directly.

## Why a separate repo

The [toolkit repo](https://github.com/bmir-radx/radx-data-dictionary-specification)
is a specification plus six Python libraries. dd-edit is an application with a
different toolchain (Node/Electron) and release cadence, and it consumes the
toolkit the same way any user does — as pinned released packages
(`dd-api @ git+...@vX.Y.Z#subdirectory=api`). That keeps the spec repo clean
and makes dd-edit a genuine downstream consumer of the release mechanism.

## Architecture

```
┌─────────────────────────── Electron ───────────────────────────┐
│  Main process (Node)                                           │
│   ├─ spawns the Python sidecar, health-checks, kills on quit   │
│   └─ owns file I/O (open/save dialogs, fs, recent files)       │
│  Renderer (React + TypeScript)                                 │
│   ├─ spreadsheet grid  ── the editor; source of truth: dd-json │
│   ├─ preview panes     ── CSV │ LinkML YAML │ rendered HTML    │
│   └─ problems panel    ── dd-validate findings → cell badges   │
└──────────────┬──────────────────────────────────────────────────┘
               │ HTTP, 127.0.0.1:<random port>, bearer token
┌──────────────▼──────────────┐
│  Python sidecar (FastAPI)   │   stateless — pure functions over
│  dd-api · dd-validate ·     │   dd-json in, text/findings out
│  dd-printer · dd-redcap     │
│  pinned to a released tag   │
└─────────────────────────────┘
```

### The document model

The **renderer owns the document** — a dd-json object (the toolkit's canonical
JSON representation, `{"format": "dd-json", "version": 1, "elements": [...]}`)
— plus the undo/redo stack and dirty state. The Python sidecar is **stateless**:
every endpoint is a pure function. No session state means no
two-process synchronization bugs, and the sidecar stays a thin (~200-line)
wrapper over the existing libraries.

TypeScript types for the document are **generated from
`dd-json.schema.json`** (via `json-schema-to-typescript`), the JSON Schema the
toolkit already ships — the frontend model is mechanically derived from the
spec, not hand-maintained.

A document mid-edit is transiently invalid (a half-typed datatype, an
unfinished enumeration). Consequences:

- `/validate` returns findings; it never hard-errors on bad content.
- When `/convert` fails, preview panes keep showing the last-good output with
  an error banner, instead of blanking.

### Sidecar API

| Endpoint | Wraps | Purpose |
| --- | --- | --- |
| `GET /health` | — | liveness + package versions (startup handshake) |
| `GET /meta` | `dd_core.ORDERED_DATATYPES` | datatype names, cardinalities → grid dropdowns |
| `POST /convert` | `dd_api` | any format in (CSV / LinkML / dd-json, auto-detected), any out; powers open, save, and the previews |
| `POST /validate` | `dd_validator.validate` | findings `{level, check, message, line, column, value}` for the problems panel |
| `POST /render` | `dd_printer` | the self-contained HTML page for the HTML preview |
| `POST /import/redcap` | `dd_redcap.convert_redcap` | REDCap export CSV → dd-json document |

Transport: HTTP on `127.0.0.1` at a random free port. The Electron main
process generates a bearer token, passes it to the sidecar via environment,
and every request carries `Authorization: Bearer <token>` — so other local
processes can't drive the sidecar. `/health` is exempt (it holds no data).

### Sidecar lifecycle

Electron main: pick a free port → spawn the sidecar (`python -m
dd_edit_sidecar --port N`; the interpreter resolves to `sidecar/.venv` in dev,
a PyInstaller binary in production, or `DD_EDIT_SIDECAR_CMD` override) → poll
`/health` until ready → open the window; kill the child on quit. If
`DD_EDIT_SIDECAR_URL` is set, no spawn happens (dev convenience: run uvicorn
yourself with reload).

## The editor (spreadsheet UX)

Rows = data elements, columns = the spec's fields. **Row order is semantic**
(element order = column order in the target datafile), so rows support
drag-reorder, and copy/paste of whole rows preserves order.

```
┌──────────┬──────────────┬───────────┬──────┬─────┬──────────────────────┬───┐
│ Id       │ Label        │ Datatype ▾│ Card │ Req │ Enumeration          │ … │
├──────────┼──────────────┼───────────┼──────┼─────┼──────────────────────┼───┤
│ nih_sex  │ Sex at birth │ integer   │ sing │ ☑   │ "1"=[Male] | "2"=… ⧉ │   │
│ age      │ Age          │ integer   │ sing │ ☑   │                      │   │
│ symptoms │ Symptoms     │ string    │ mult │ ☐   │ "1"=[Fever] | "2"=…⧉ │   │
╞══════════╧═ Section: Demographics ══╧══════╧═════╧══════════════════════╧═══╡
│ …                                                                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ ▸ Problems (2)   ⚠ age: unit missing    ✖ nih_sex: duplicate id             │
└──────────────┬──────────────────────────────────────────────────────────────┘
   CSV preview │ LinkML preview │ HTML preview       (right split, toggleable)
```

- **Grid library: [Glide Data Grid](https://github.com/glideapps/glide-data-grid)**
  (MIT). Canvas-based and genuinely spreadsheet-feeling: built-in fill handle,
  range selection, and multi-cell copy/paste that interoperates with
  Excel/Sheets via TSV. (AG Grid Community lacks fill handle and range
  selection — Enterprise-only; Handsontable is commercially licensed.)
- **Simple cells** edit inline. **Datatype** is a dropdown fed by `/meta`;
  **cardinality** a single/multiple toggle; **required** a checkbox.
- **Structured cells** (enumeration, missing-value codes, terms) support both
  modes: a popover mini-editor (value / label / IRI rows) *and* raw in-cell
  grammar text (`"1"=[Male] | "2"=[Female]`) — the spec's in-cell grammar is
  already the spreadsheet-efficient encoding, and users coming from the CSV
  know it.
  `dd_core`'s parser (via `/validate`) checks it as you type.
- **Sections** render as collapsible row groups.
- **Keyboard-first**: arrows/Tab/Enter navigation, F2 edit, Ctrl+Z/Y
  undo/redo, Ctrl+D fill-down, paste a TSV block from Excel to create rows.
- **Undo/redo** is a command stack over the document model (not DOM state), so
  every mutation — cell edit, row reorder, paste block, import — is one
  undoable command.

## Previews

Debounced (~300 ms) after each document change: the renderer sends the dd-json
to `/convert` and displays the CSV and LinkML YAML in read-only CodeMirror
panes (syntax-highlighted, copy/save buttons), and the `dd_printer` HTML in a
sandboxed `<webview>`/iframe. Panes are individually toggleable; previews
pause when hidden.

Validation runs on the same debounce. Since the backend generates the CSV
deterministically (data row *i* = element *i*), the validator's line numbers
map directly to grid rows — findings become cell badges plus entries in the
problems panel, no fuzzy matching.

## Opening files, saving, and REDCap import (v1)

- **Open** handles all three toolkit formats — `.csv` (data dictionary),
  `.yaml`/`.yml` (LinkML), `.json` (dd-json) — auto-detected by content, via
  `/convert?to=json`.
- **Import → REDCap export…** runs `/import/redcap` (with optional provenance
  string and the tolerate-duplicates flag for multi-form exports) and opens
  the result as a new *untitled, dirty* document — an import, not an open:
  saving prompts for a destination, and the original REDCap file is never
  written to.
- **Sniff-and-offer**: opening a `.csv` that fails dictionary parsing but has
  REDCap headers (`Variable / Field Name`, ...) offers one-click import
  instead of a bare error.
- **Save/Save As** to any of the three formats through `/convert`; the format
  follows the extension. A dictionary opened from CSV keeps saving to CSV
  unless the user chooses otherwise.
- **Fidelity warning**: files with unknown extra columns round-trip through
  the model lossily; the open flow surfaces the validator's unknown-column
  findings and warns before the first save.

## Packaging

- **Dev**: `electron-vite` (HMR for renderer, main, preload); sidecar runs
  from `sidecar/.venv` (uvicorn).
- **Prod**: PyInstaller one-dir build of the sidecar in `extraResources`;
  `electron-builder` for installers (macOS first). Main process spawns the
  bundled binary. Auto-update deferred until after v1.

## Milestones

1. **Skeleton** — repo, sidecar with all six endpoints, Electron shell that
   spawns it, health handshake shown in the window. *(Proves the risky part —
   process lifecycle — before UI investment.)*
2. **Editing core** — open/save via `/convert`, grid with inline editing of
   simple fields, undo/redo, row add/delete/reorder, live CSV preview,
   **REDCap import**.
3. **Rich cells** — datatype dropdown from `/meta`, enumeration/missing-value
   popover editors + raw grammar editing, LinkML preview.
4. **Validation** — problems panel + cell badges wired to `/validate`.
5. **Polish & ship** — HTML preview, clipboard/fill-handle hardening,
   PyInstaller + electron-builder packaging.

## Repo layout

```
dd-edit/
├── DESIGN.md               # this document
├── package.json            # Electron app (electron-vite)
├── src/
│   ├── main/               # Electron main process (sidecar lifecycle, file I/O)
│   ├── preload/            # context bridge
│   └── renderer/           # React UI
└── sidecar/
    ├── pyproject.toml      # dd-* pinned to a released tag
    └── dd_edit_sidecar/    # FastAPI app
```

## Decisions log

| Decision | Choice | Why |
| --- | --- | --- |
| Repo | separate, `dd-edit` | different toolchain/cadence; consumes released packages; name matches the `dd-*` CLI family |
| Wire format | dd-json | canonical, versioned, has a JSON Schema → generated TS types |
| Backend state | stateless | no sync bugs; sidecar stays a thin wrapper |
| Grid | Glide Data Grid | MIT; fill handle + range selection + TSV clipboard are built in |
| Transport | localhost HTTP + bearer token | debuggable with curl; token keeps other local processes out |
| REDCap | import in v1 | one endpoint over `dd_redcap`; opens as untitled document |
| Frontend stack | React + TS + electron-vite + zustand + CodeMirror | boring, well-trodden |
