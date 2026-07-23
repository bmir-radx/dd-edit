# dd-edit MCP — design

An [MCP](https://modelcontextprotocol.io) server that exposes data-dictionary
capabilities to an LLM: **validate, query, and author** [RADx data
dictionaries](https://github.com/bmir-radx/radx-data-dictionary-specification)
from any MCP client (Claude Desktop, Claude Code, …).

It is a sibling to the app's Python sidecar — the *same* thin wrapper over the
*same* `dd-*` toolkit, speaking MCP instead of HTTP. See
[DESIGN.md](../DESIGN.md) for the app and sidecar it grows out of.

## Why this is tractable

The hard part already exists. The domain logic — parsing, validation, HTML
rendering, format detection, REDCap conversion, term lookup — lives in the
toolkit libraries (`dd-api`, `dd-validate`, `dd-printer`, `dd-redcap`,
`dd-core`) that the sidecar already depends on. The sidecar
([sidecar/dd_edit_sidecar/app.py](../sidecar/dd_edit_sidecar/app.py)) proves the
consumption pattern: ~265 lines of pure functions, dd-json in, results out.

An MCP server is the same shape with a different transport. Almost every tool we
want maps onto something the sidecar already does — so the work is **tool-schema
design and packaging**, not domain logic.

## Goals

- **Validate as a service** — an agent building a dictionary elsewhere calls in
  to check it (duplicate ids, unit validity, schema conformance).
- **Query** — answer questions about an existing dictionary (what fields exist,
  unit usage, coverage gaps, export to CSV/LinkML/HTML).
- **Author / edit** — help create and modify elements (add fields, fix naming,
  suggest units/CDE mappings, import REDCap).
- **Broad adoption** — usable by anyone, not just this lab. That raises the bar
  on tool descriptions, parameter shapes, and distribution.

## The three phases

The end state we're building toward is **live human + LLM collaboration on the
same open document** — Claude editing a dictionary a researcher has open in
dd-edit. That is a real destination, not a maybe. But it is the *last* phase,
because every phase below it is a building block for the one above.

```
Phase 3   Live app integration    Claude ⇄ MCP ⇄ running dd-edit, shared document
             (stateful, hardest)      ▲ session backed by the app's live document
Phase 2   Sessions                 open/close a held document; edits mutate in place
             (stateful)               ▲ session wraps the phase-1 operations
Phase 1   Stateless core + MCP     pure (dictionary, op) → (dictionary, findings)
             (start here)             the tested primitives everything else uses
```

Starting stateless is not timidity and not a throwaway detour: the stateless
operations *are* the building blocks of phases 2 and 3. A session's
`edit_element` is the stateless `edit_element` applied to a held document; the
live integration is a session whose backing document is the one open in the app.
You cannot build the upper phases without correct, tested primitives first.

### Phase 1 — stateless core + MCP server

Mirror the sidecar's philosophy ([DESIGN.md → document model](../DESIGN.md)):
the server holds no state, every tool is a pure function over **dd-json** (the
toolkit's canonical `{"format":"dd-json","version":1,"elements":[...]}`).

Editing tools take a document plus an operation and return the **new document
plus fresh validation findings**. The client (the LLM's context) holds the
document between calls.

Deliverable: a usable validate/query/author server, and the tested primitives
the later phases build on. Proves the toolkit imports and runs outside FastAPI.

### Phase 2 — sessions

Add `open_dictionary` / `close_dictionary`. Editing tools optionally take a
session handle instead of an inline document; the server holds one authoritative
copy and mutates it in place. Same core logic — a lifecycle layer on top.

This is what fixes the stateless pain points (see *When to go stateful*).

### Phase 3 — live app integration

A session whose backing document is the one open in a running dd-edit instance,
so a human and Claude edit together. This is where the MCP meets the app: the
flashiest and hardest part, and the one that most needs the lower layers solid.

Not built now — but phase-1 choices must not foreclose it (see *Phase-3
constraints*).

## Tool inventory (phase 1)

Grouped by use case. "Wraps" points at the sidecar endpoint / toolkit call that
already does this, so each is a known quantity.

### Validate

| Tool | Wraps | Purpose |
| --- | --- | --- |
| `validate_dictionary` | `dd_validator.validate` (`POST /validate`) | findings `{level, check, message, line, column, value}` for a dd-json (or any auto-detected format) document |

### Query

| Tool | Wraps | Purpose |
| --- | --- | --- |
| `list_elements` | `DataDictionary` model (`_load`) | ids/labels/datatypes, optionally filtered (by section, datatype, missing-field) |
| `get_element` | `DataDictionary` model | full detail for one element by id |
| `describe_dictionary` | `DataDictionary` + `GET /meta` | summary: element count, sections, datatypes in use, validity |
| `export` | `dd_api` + `EmitOptions` (`POST /convert`) | dd-json → CSV / LinkML YAML / dd-json |
| `render_html` | `dd_printer.render_html` (`POST /render`) | the self-contained HTML page |

### Author / edit  *(pure: return new document + findings)*

| Tool | Wraps | Purpose |
| --- | --- | --- |
| `add_element` | model mutation + re-validate | append/insert an element; returns new doc + findings |
| `edit_element` | model mutation + re-validate | change fields on an element by id |
| `remove_element` | model mutation + re-validate | delete an element by id |
| `reorder_elements` | model mutation | change element order (order is semantic — see DESIGN.md) |
| `lookup_terms` | `dd_core.terms_lookup.lookup_labels` (`POST /terms`) | resolve unit/CDE IRIs → labels for suggestions |
| `import_redcap` | `dd_redcap.convert_redcap` (`POST /import/redcap`) | REDCap export CSV → dd-json document |

Notes:
- Every editing tool returns `{document, findings}` — the caller sees validity
  immediately, matching the app's "validate on every change" behaviour.
- A document mid-edit may be transiently invalid; like the sidecar, tools return
  findings and never hard-error on bad content ([DESIGN.md](../DESIGN.md)).
- `GET /health`-equivalent version reporting belongs in the MCP server's
  initialize/metadata, not a tool.

## Stateless tool signature (the shape that survives into phase 2)

The editing primitive is deliberately pure so a session can wrap it unchanged:

```
edit_element(document: DdJson, id: str, changes: ElementPatch)
    -> { document: DdJson, findings: Finding[] }
```

In phase 2 the same operation becomes the mutation applied to a held document:

```
edit_element(session: SessionId, id: str, changes: ElementPatch)
    -> { findings: Finding[] }        # server holds the document
```

Design rule for phase 1: **tools take a document argument, not an implicit
"current" document.** Nothing assumes a single global document. That is the one
assumption a session model would contradict, so we avoid baking it in.

## When to go stateful

Written-down triggers, so we watch for signals instead of rediscovering them.
Reasons 1, 2, 4 are performance/ergonomics and may never bite for typical
dictionaries; reason 3 is a product decision that takes us to phase 3 regardless.

1. **Round-tripping the document gets expensive or lossy.** Stateless editing
   ships the whole document in and out on every call. The app's own test data is
   ~870 lines; a large dictionary could be big enough that per-call round-trips
   burn tokens and the LLM starts truncating/paraphrasing/dropping fields on the
   return trip. That drift is the clearest "move the document server-side" signal.
2. **Multi-step edits must stay coherent.** "Add 12 fields, rename a group,
   re-validate" round-trips the whole document per step; if the model regenerates
   it slightly differently between steps, edits silently drift. A session keeps
   one authoritative copy.
3. **Human + LLM on the same open document.** Stateless cannot express a shared
   mutable document. This is phase 3 and the strongest reason — if live
   collaboration is wanted (it is), we go stateful eventually no matter what.
4. **Expensive setup repeated per call.** If parsing/indexing a dictionary or a
   term-lookup table turns out slow, stateless pays it every call; a session pays
   once. Measure before assuming.

Trade being made: statelessness costs **tokens + multi-step ergonomics**;
statefulness costs **complexity** — document lifecycle, concurrency (two clients,
one session), session persistence/expiry, client-disconnect-mid-edit.

## Phase-3 constraints (design v1 without foreclosing these)

Not solved now — flagged so phase-1/2 choices leave room.

- **Reaching the app's live document.** Today the link is one-directional: the
  Electron main process spawns the sidecar on `127.0.0.1:<random port>` with a
  bearer token, and the **renderer owns the document** (dd-json + undo stack),
  talking to the sidecar over HTTP ([DESIGN.md → architecture](../DESIGN.md)).
  For live collaboration the document state must be reachable and *mutable* from
  outside the app — which touches the main process, the sidecar's statelessness,
  and a change-notification channel back to the grid.
- **Existing seam.** `DD_EDIT_SIDECAR_URL` already lets the app point at an
  externally-running sidecar. The port+token channel is the likely seam for
  phase 3 — but note the sidecar is stateless *by design*; live integration adds
  state somewhere, and where (a new component vs. relaxing the sidecar) is an
  open question.
- **Undo/redo interaction.** The app's undo stack is a command stack over the
  document model. LLM edits arriving through the MCP need to become undoable
  commands too, or the human's undo and the LLM's edits desynchronise.
- **Conflict model.** Two editors on one document need *some* answer for
  simultaneous edits, even if v1 of phase 3 is "last-writer-wins with a
  notification."

## Packaging & distribution (adoption)

- The `dd-*` deps come from the spec repo pinned to a git tag
  (`...@v0.0.7#subdirectory=api`), same as the sidecar. A published MCP needs
  those installable by others — confirm the story early: PyPI release of the
  toolkit, vendoring, or documenting the git install.
- Ship as a `pip`/`pipx`-installable console entry point exposing an MCP stdio
  server; optionally a `uvx` one-liner for zero-install trial.
- Tool descriptions and parameter schemas are the actual product surface for
  adoption — an LLM must use them without reading source. Budget real effort here.

## Open questions

- Do editing tools operate on **dd-json only**, or also accept CSV/LinkML inline
  (auto-detect like `/convert`)? Leaning dd-json-only for edits, any-format for
  validate/query/export.
- Is `render_html` worth exposing to an LLM, or is it a human-facing artifact
  better left to the app? (Include but low priority.)
- Reuse the sidecar package directly (import `dd_edit_sidecar` helpers like
  `_load`/`_detect`) or factor the shared core into a small library both consume?
  Factoring is cleaner for adoption but is refactoring work on shipped code.

## Decisions log

| Decision | Choice | Why |
| --- | --- | --- |
| Relationship to app | standalone server, reuses toolkit | simpler, stateless, reusable; adoption-friendly |
| Start state | stateless (phase 1) | primitives for all later phases; no sync bugs; mirrors sidecar |
| End state | stateful, live app integration (phase 3) | the collaboration goal is stated, not hypothetical |
| Wire format | dd-json | canonical, versioned, JSON Schema → types (as in the app) |
| Editing tool shape | pure `(document, op) → (document, findings)` | survives unchanged into a session model |
| Tool arg | explicit document, no implicit "current" doc | the one assumption a session would contradict |
