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

### Phase 2 — sessions — **built**

`open_dictionary` / `close_dictionary` / `list_sessions`, plus an optional
`session_id` on every document-taking tool. The server holds one authoritative
copy in `sessions.py` and mutates it in place. Same core logic — a lifecycle layer
on top, wrapping the pure functions rather than reimplementing them.

Measured over stdio, five edits on a 60-element dictionary: **360 KB stateless vs
37 KB in a session (~90k → ~9k tokens), with a byte-identical final document.**

Two things earn most of that, and only one was obvious:
- A session reply carries a summary, not the document.
- A session reply carries a **findings digest**, not every finding. This was the
  surprise: a 60-element dictionary has 60 `missing-unit` INFO findings, and
  returning them all made the reply 16.7 KB against a 105-byte summary — 42% of
  stateless rather than 10%. Errors come back in full (capped, with
  `errorsOmitted`); everything else is counts by check, with the full list a
  `validate_dictionary(session_id=…)` away. The general lesson: in a session
  design, *anything* proportional to document size has to be paged or summarised,
  not just the document. `save_dictionary` is the next application of that lesson
  — saving via `export` sends the document out and back, which put the whole
  dictionary on the wire twice per save even with a session open.

No expiry, in-memory, process-scoped: a document a client is editing must not
evaporate mid-conversation, and for a stdio server the process *is* the
conversation. An idle timeout only makes sense for a long-lived shared server,
which this is not yet.

The stateless path is unchanged and stays the right mode for a one-shot edit. That
was also the safety property: all 74 phase-1 tests passed untouched, so the
refactor provably did not change what an edit means.

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
| `remove_element` | model mutation + re-validate | delete an element by id and/or index (refuses an ambiguous id) |
| `reorder_elements` | model mutation | change element order via a full id permutation (order is semantic — see DESIGN.md) |
| `lookup_terms` | `dd_core.terms_lookup.lookup_labels` (`POST /terms`) | resolve unit/CDE IRIs → labels for suggestions |
| `import_redcap` | `dd_redcap.convert_redcap` (`POST /import/redcap`) | REDCap export CSV → dd-json document |

### Save  *(the one tool that touches the filesystem)*

| Tool | Wraps | Purpose |
| --- | --- | --- |
| `save_dictionary` | `export` + a file write | serialise to a path and return a summary, not the text; `--save-root DIR` optionally confines it to one directory |

Notes:
- Every editing tool returns `{document, findings}` — the caller sees validity
  immediately, matching the app's "validate on every change" behaviour.
- A document mid-edit may be transiently invalid; like the sidecar, tools return
  findings and never hard-error on bad content ([DESIGN.md](../DESIGN.md)).
  **One exception, found while building `edit_element`:** the toolkit's model
  refuses to *hold* some bad values — `from_json` raises `ReadError` on an
  unknown datatype or a malformed enumeration/precondition, and there is no
  leniency knob for them (unlike `allow_duplicate_ids`, which is why a duplicate
  id *is* a finding). Those raise `ValueError`, re-worded to name the element and
  the offending change rather than a line of the internal CSV round-trip. Worth
  revisiting if the toolkit ever gains a lenient-datatype parse.
  Every editing tool shares this round-trip tail (`core._apply`) so the rule is
  stated once and the tools cannot drift apart — every editing tool goes through
  it.
- **`lookup_terms` is the only impure tool, and it fails soft.** Everything else
  is offline and deterministic; this one queries OLS4. A term that does not
  resolve is *absent* from the result rather than an error (it may be private,
  retired, or mistyped), so the tool also returns `unresolved` to make the misses
  explicit rather than something the caller has to diff for. Batches are
  de-duplicated and capped at 100, matching the sidecar's `/terms`, so one call
  cannot fan out into hundreds of upstream lookups. Only a transport failure
  raises. Consequence for the suite: the upstream call is stubbed by default and
  the real path is a `live`-marked opt-in (`pytest -m live`) — an offline
  developer, or CI without egress, must still get a green run.
- **`import_redcap` creates a document instead of editing one**, so it is the only
  author-group tool with no input document. It still returns `{document,
  findings}` like the rest, because a converted dictionary is a starting point,
  not a finished one — REDCap carries no units, so `missing-unit` findings are the
  to-do list. REDCap's branching logic is **dropped, not translated**: its grammar
  is not the spec's precondition grammar, and a guessed translation would be wrong
  in ways nobody would notice. `allow_duplicates=True` keeps the first occurrence
  of a repeated variable and silently drops the rest, which is why the tool
  reports `elementCount` — the caller needs a way to notice the loss.
- **Destructive tools refuse ambiguity instead of taking the first match.**
  `get_element` and `edit_element` act on the first element with a given id,
  which is fine because a duplicate id is visible in the document they return and
  a wrong edit can be re-edited. `remove_element` refuses and reports the
  matching positions, because a wrong deletion leaves no trace in the result and
  a stateless tool has no undo stack to fall back on. `index` is the
  disambiguator, matching the app, whose delete/insert/move/setField primitives
  are all index-based (`document.ts` `deleteElements(doc, indices)`) — an id is
  the natural handle for an LLM, so the MCP takes ids and treats index as the
  precise address. Passing both is an assertion: "this index, which must have
  this id" — worth it against a stale listing.
- **`ElementPatch` semantics** (decided for `edit_element`, applies to any later
  patch-shaped tool): an omitted key leaves the field untouched, an explicit
  `null` clears it, `[]` clears a list. This mirrors the app, which stores a
  cleared optional scalar as `null` — never `""`, never a missing key
  (`GridView.tsx` `spec.nullable`, `ElementInspector.tsx` `commitNullable`) — and
  never distinguishes "absent" from "explicitly empty". `id`/`label`/`datatype`
  are non-optional and cannot be cleared. Renaming via `{"id": ...}` does not
  rewrite references elsewhere; a dangling reference shows up in the findings.
- `GET /health`-equivalent version reporting belongs in the MCP server's
  initialize/metadata, not a tool.

## Writing files (`save_dictionary`)

Every other tool here is text in, text out. That is what makes the server safe to
hand to an arbitrary client, and it was the assumption behind "the app writes the
file" in the `compact` decision below. `save_dictionary` is the one exception, and
it exists for a measured reason.

**The problem it solves is token cost, not convenience.** Without it, saving means
`export` → the caller writes the file itself. The document therefore crosses the
wire *twice*: once in the export reply, once in the caller's write call. On a
22-element dictionary that is ~3.1k tokens each way. `save_dictionary` returns
`{path, format, bytesWritten, sha256, existed, valid, elementCount}` — ~64 tokens,
and the document never leaves the server. Over a working session that repeatedly
edits and saves, this dominates. Measured on the seven saves of one real authoring
run (six CSV, one LinkML, a 22-element dictionary): **~50.7k tokens via `export`
plus a write, against ~450 via this tool.**

That is the same argument as sessions (below), one step further: a session stops
the *document* round-tripping on every edit, and this stops it round-tripping on
every save.

**Saving is allowed by default, and `--save-root` narrows it.** The first version
had this the other way round — the tool refused unless a root was configured —
which was wrong, and worth recording as a design mistake rather than quietly
reversing.

The reasoning that produced it was a threat model with no threat: writing to disk
*felt* like it needed a boundary, so one was built. But an MCP client already
prompts a human before running a tool, and that gate is strictly better than a
startup flag — it is per call, with the arguments visible, rather than a blanket
grant made once at configuration time. Requiring both meant every interactive user
paid setup friction (an extra argument, an absolute path, and a failure mode where
saving silently does not work) to be protected from a misplaced CSV, on a server
whose host can usually run shell commands anyway.

So the flag survives for the case the client genuinely cannot cover: an agent
running unattended — cron, CI, a background loop — where nothing prompts per call
and a path bound is the only bound there is. For interactive use it is
unnecessary.

**When a root is set, two further guards apply:**
- **Confined to the root.** Paths resolve (`Path.resolve()`) *before* the
  containment check, so a `..` path, an absolute path elsewhere, and a symlinked
  *destination* are all refused. Checking the string the caller sent would catch
  none of them. Relative paths resolve against the root. Known limit: because
  `resolve()` follows every component, a symlinked *intermediate directory* inside
  the root leads somewhere the check then accepts as legitimate. That is only
  reachable by someone who can already create directories in the root, which is a
  directory the operator chose — so it is recorded rather than defended against.
  Walking each component would close it if the root ever becomes shared.
- **Refuses to clobber silently.** `expect_sha256` is the concurrency guard: pass
  the digest you believe is on disk and the write is refused if the file changed
  since. This is not hypothetical — it is exactly the phase-3 conflict case
  arriving early, with a human editing a file in dd-edit while an LLM edits a
  session of the same document. Passing a digest for a file that does not exist is
  an error rather than a no-op, because it always means the caller is confused
  about what it is overwriting.

**Format comes from the extension** (`.csv`, `.yaml`/`.yml`, `.json`), with `to=`
as an override. An unrecognised extension is refused rather than guessed.

**Relationship to phase 3.** This does not replace the phase-3 answer, and should
not grow into one. There, the file on disk is the app's business: the MCP edits
the document open in dd-edit and the app saves it, with the undo stack and change
notification intact. `save_dictionary` is for the case phase 3 does not cover —
an agent authoring a dictionary with no app running — and its `expect_sha256`
check is a stopgap for concurrency, not the conflict model. If phase 3 lands and
the "no app running" case turns out to be rare, this is a candidate for removal.

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

   **Measured, and half-mitigated.** A realistically-populated 60-element
   dictionary is ~8.1k tokens of dd-json, so one single-field edit ships ~16k
   tokens (document in, document out) and a ten-step session burns ~160k. Adding
   `compact` (the toolkit's `to_json(compact=True)`, which omits null/empty
   fields) to every document-returning tool halves that — 28.5 KB → 14.0 KB on
   that dictionary, verified over stdio. It is lossless and accepted as input
   everywhere, so a caller can hold the compact form between calls.

   Note what this does and does not fix. It addresses the **cost** half of the
   trigger, and it will keep paying off for one-shot stateless edits, which remain
   the right mode for a single change. It does **not** address the **drift** half:
   the model still re-emits the whole document each round-trip, and can still
   paraphrase or drop a field on the way through. Only server-held state fixes
   that, which is why compact is a mitigation rather than a reason to skip phase 2.
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
  notification." `save_dictionary`'s `expect_sha256` is a first, narrow instance
  of the problem — compare-and-swap on a *file* — and it is worth noting that the
  case showed up in practice long before phase 3: a human had the CSV open in
  dd-edit while an LLM was overwriting it from a session. Whatever phase 3
  chooses should subsume that check rather than sit beside it, since a document
  reachable in the app is the more precise thing to guard than the bytes on disk.

## Packaging & distribution (adoption)

- The `dd-*` deps come from the spec repo pinned to a git tag
  (`...@v0.0.7#subdirectory=api`), same as the sidecar. A published MCP needs
  those installable by others — confirm the story early: PyPI release of the
  toolkit, vendoring, or documenting the git install.
- Ship as a `pip`/`pipx`-installable console entry point exposing an MCP stdio
  server; optionally a `uvx` one-liner for zero-install trial.
- Tool descriptions and parameter schemas are the actual product surface for
  adoption — an LLM must use them without reading source. Budget real effort here.
  Concretely, they carry: the precondition grammar (in `edit_element` — otherwise
  a caller guesses the syntax and gets `malformed-precondition` back), the shape
  of the non-string fields (`enumeration`/`missing_value_codes` are
  `[{value, label, iri}]`; `terms`/`aliases`/`examples` are plain string lists),
  and the check names an edit tends to trip (in `validate_dictionary`).
  `tests/test_server.py` pins each documented claim, so the docs cannot rot into
  lies without a test failing.
- **Three toolkit coercions are now refused rather than documented.** An
  enumeration item with no `value` is dropped, a list of bare strings is dropped
  whole, and `terms` given objects is stringified and split on whitespace. These
  were originally described in the tool docstrings as traps to avoid — which was
  not enough. A real session passed enumerations as bare strings, got
  `valid: true` with zero findings three times over, and lost three
  enumerations; the mistake surfaced only when an export to CSV showed empty
  cells. Nothing downstream *could* have caught it, because an element with no
  enumeration is structurally valid, so there is no check to fire. A warning in
  prose is no defence against a value that vanishes quietly. `_check_field_shapes`
  now rejects the wrong shape at the same point both editing tools already
  validate keys, with a message naming the shape wanted.
- Descriptions plus input schemas are shipped on every request, so they are a
  standing cost: **15 tools, ~29 KB (~7.5k tokens)** as of `save_dictionary` —
  up from ~13 KB at nine tools, as sessions and saving landed. `edit_element`
  alone is ~5.9 KB, which is the right place to spend it (it carries the
  precondition grammar). Worth re-measuring rather than estimating when tools are
  added; the number above came from `list_tools()` over the in-process client, the
  same path `tests/test_server.py` uses.
- **Bound the MCP SDK dependency at the major** (`mcp>=2,<3`). The original
  `mcp>=1.2` was unbounded, so SDK 2.0 — which renamed `fastmcp.FastMCP` to
  `mcpserver.MCPServer` and dropped `shared.memory`'s test helper — was resolved
  by a fresh `pip install` and the server failed to import on arrival, while
  every existing venv kept working. That failure mode is invisible to whoever
  wrote the pin, which is the argument for the bound rather than for vigilance.
- The console entry point reports its version from package metadata
  (`importlib.metadata`), so a client's handshake shows something meaningful
  instead of an empty string. Keep that in step with `pyproject.toml`'s version.
- **The package directory is `mcp-server/`, not `mcp/`** — resolved. A directory
  named `mcp` shadows the `mcp` library for any tool that puts the repo root on
  `sys.path`, so `uv run` from the root failed with
  `No module named 'mcp.server...'` while venv-based invocation worked, which is
  the sort of split that wastes an afternoon. A hyphen cannot be a module name, so
  the class of bug is gone rather than documented. The Python package stays
  `dd_edit_mcp` and the console script stays `dd-edit-mcp`; only the directory
  moved.

## Open questions

- Is `render_html` worth exposing to an LLM, or is it a human-facing artifact
  better left to the app? (Include but low priority.)
- Should a rename (`edit_element` with `{"id": ...}`) or a removal offer to
  rewrite references to the old id (e.g. in a `precondition`)? Today neither does:
  the reference text is left alone and the orphan surfaces as an
  `unknown-precondition-field` ERROR. **The app behaves the same way** — its
  `deleteElements` and id-`setField` touch nothing else, and the stale reference
  is only flagged later, when the user happens to open that other element's
  precondition field (`precondition.ts` `analyze`). So the MCP is consistent with
  the app rather than worse than it, and a reference-fixing `rename_element` would
  be a *new* capability for both. Worth doing if it bites in practice.

## Decisions log

| Decision | Choice | Why |
| --- | --- | --- |
| Relationship to app | standalone server, reuses toolkit | simpler, stateless, reusable; adoption-friendly |
| Start state | stateless (phase 1) | primitives for all later phases; no sync bugs; mirrors sidecar |
| End state | stateful, live app integration (phase 3) | the collaboration goal is stated, not hypothetical |
| Wire format | dd-json | canonical, versioned, JSON Schema → types (as in the app) |
| Editing tool shape | pure `(document, op) → (document, findings)` | survives unchanged into a session model |
| Tool arg | explicit document, no implicit "current" doc | the one assumption a session would contradict |
| Edit input format | any format in (auto-detected), dd-json out | one rule for every tool is less to explain to an LLM than "edits are dd-json-only"; the round-trip normalises anyway |
| Shared core | factored into `dd-edit-core` | one place for parse/validate + the feature-detected toolkit knobs; the sidecar and MCP can't drift |
| Patch semantics | omit = leave, `null` = clear, `[]` = clear list | matches the app exactly, so LLM and human edits mean the same thing |
| Ambiguous id on delete | refuse, report positions, offer `index` | a wrong delete is invisible in the result and there is no undo; a wrong edit is neither |
| Session state | `sessions.py` in the MCP, wrapping the pure core functions | keeps `core.py` transport-free and shareable (the reason `dd-edit-core` was extracted); phase 3 swaps what a session holds without touching the tools |
| Session API | optional `session_id` alongside `content`, not separate `session_*` tools | doubling the tool count would double the description budget an LLM reads, for near-duplicates; sharing one path means an edit cannot mean two things |
| Absent-argument sentinel | `content: str = ""`, **not** `str \| None` | the SDK pre-parses a string argument into JSON unless the annotation is exactly `str` (`func_metadata.pre_parse_json`), so `str \| None` silently turned a dd-json document into a dict — caught only by feeding a returned document back in |
| Session reply findings | ERRORs in full (capped), the rest as counts by check | findings scale with the document, which is precisely what a session exists to avoid; returning all of them cost 16.7 KB against a 105-byte summary |
| `compact` output | opt-in on every document-returning tool; full form is the default | halves the bytes a stateless caller carries, losslessly; the default stays full because a file for disk should carry every field, as the app's writes do |
| Writing files | one tool (`save_dictionary`), allowed by default | the document crossing the wire twice per save (out via `export`, back via the caller's write) is the dominant token cost in an authoring run — measured at ~50.7k tokens across one run's seven saves, against ~450 for summary replies |
| Save permission | `--save-root DIR` narrows; unset by default | **reversed from off-by-default, which was a mistake.** The MCP client already prompts a human per tool call — a better gate than a startup flag, since it is per call with arguments visible. Requiring both taxed every interactive user to prevent a misplaced CSV. The flag remains for an unattended agent, where no client prompts and a path bound is the only bound. When set: resolved before the containment check so a `..` path or symlinked destination cannot escape, plus an optional `expect_sha256` compare-and-swap |
| Reorder shape | full id list, must be an exact permutation | declarative and order-of-operations-free; the permutation check is what stops a truncated list from silently dropping elements. The app's `moveElement(from, to)` is a drag-and-drop affordance, not the right shape for a caller that cannot see the grid or track shifting indices across calls |
