# dd-edit-mcp

An [MCP](https://modelcontextprotocol.io) server exposing RADx data-dictionary
tools to an LLM. Design: [../docs/MCP-DESIGN.md](../docs/MCP-DESIGN.md).

**Status: phase 2 (sessions) landed.** Fourteen tools covering validate, query,
author, and the session lifecycle. Phase 1's inventory is complete except
`render_html`, which the design doc rates low priority (a human-facing artifact,
arguably the app's job).

Every document-taking tool works two ways: pass `content` for a one-shot stateless
call, or `session_id` to work against a document the server is holding. Neither is
privileged — see *Sessions* below for which to reach for.

The element-editing set — `add_element`, `edit_element`, `remove_element`,
`reorder_elements` — is uniform: pure `(document, op) → (document, findings)`,
sharing one round-trip tail (`core._apply`). Phase 3 (the app's live document)
replaces what a session holds without changing the tools above it.

`lookup_terms` is the exception to "pure and offline": it queries OLS4 over the
network. The suite stubs it, so `pytest` stays deterministic; `pytest -m live`
runs the one test that really goes out.

## Layout

```
mcp-server/
├── pyproject.toml          # dd-* pinned to a released tag (in step with the sidecar)
├── dd_edit_mcp/
│   ├── core.py             # pure ops over the toolkit — no MCP, no FastAPI
│   ├── sessions.py         # phase 2: documents the server holds, by handle
│   └── server.py           # MCPServer stdio server; wraps core in the 14 tools
└── tests/test_server.py    # core directly + protocol round-trips
```

The directory is `mcp-server/`, not `mcp/`: a directory named `mcp` shadows the
`mcp` library for any tool that puts the repo root on `sys.path` (`uv run` from
the root failed with `No module named 'mcp.server...'`). A hyphen is not a legal
module name, so it cannot shadow anything; the Python package is still
`dd_edit_mcp` and the command is still `dd-edit-mcp`.

`core.py` is deliberately transport-free — pure functions over the toolkit, with
`server.py` adding only the MCP-facing docstrings and result shapes. `sessions.py`
wraps those same pure functions rather than reimplementing them, so an edit means
exactly one thing in both modes; that is what let phase 2 land with every phase-1
test passing untouched.

## Develop

```bash
python -m venv .venv
.venv/bin/pip install -e ../core        # regular install, see the release note below
.venv/bin/pip install -e ".[test]"
.venv/bin/pytest              # offline; the network test is deselected
.venv/bin/pytest -m live      # just the real OLS4 lookup (needs network)
```

Built against the **MCP SDK 2.x** (`mcp>=2,<3`). 2.0 renamed the server class
(`fastmcp.FastMCP` → `mcpserver.MCPServer`) and replaced the in-memory test
helper with `Client(InMemoryTransport(server))`, so the pin is bounded at the
major — an unbounded `>=` is what let a major bump break the imports the first
time. Upgrading a venv built before this: re-run the `pip install -e` above.

Run pytest from this directory, so `pyproject.toml`'s config (including the
`live` marker exclusion) is picked up.

## Run

```bash
python -m dd_edit_mcp.server      # stdio MCP server
```

Wire into an MCP client (e.g. Claude Desktop `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "dd-edit": {
      "command": "/path/to/.venv/bin/python",
      "args": ["-m", "dd_edit_mcp.server"]
    }
  }
}
```

## Tools

All tools accept a dictionary in any toolkit format (dd-json / LinkML YAML / CSV,
auto-detected).

| Tool | Group | Purpose |
| --- | --- | --- |
| `open_dictionary` | session | Hold a document server-side; returns `{sessionId, revision, …}`. |
| `close_dictionary` | session | End a session and get the final document back. |
| `list_sessions` | session | What the server is currently holding. |
| `validate_dictionary` | validate | Findings for a dictionary; returns `{detected, valid, findings}`. |
| `list_elements` | query | Element summaries `{id, label, datatype, section}`, filterable by section / datatype / missing field. |
| `get_element` | query | Full detail for one element by id; `{found, element}`. |
| `describe_dictionary` | query | Summary: `{elementCount, sections, datatypes, valid, errorCount, warningCount}`. |
| `export` | query | Serialise to `csv` / `linkml` / `json`; `{format, content}`. `compact` shrinks dd-json. |
| `add_element` | author | Insert an element (order-aware via `index`); returns `{document, valid, findings}`. Pure — the input is not modified. |
| `edit_element` | author | Change fields on one element by id; returns `{document, valid, findings}`. Pure. Omitted key = leave alone, `null` = clear, `{"id": ...}` = rename. |
| `remove_element` | author | Delete one element by id and/or index; returns `{document, valid, findings}`. Pure. Refuses an ambiguous (duplicated) id rather than guessing. |
| `reorder_elements` | author | Reorder elements; takes every id in the wanted order. Pure. Refuses anything but an exact permutation, so it cannot silently drop an element. |
| `import_redcap` | author | REDCap export CSV → dd-json; `{document, elementCount, valid, findings}`. Creates a document rather than editing one. Branching logic is dropped, not translated. |
| `lookup_terms` | query | Resolve term IRIs → labels; `{labels, unresolved}`. **The only tool that uses the network** (OLS4). Unresolved terms are absent, not errors. |

Patch semantics for `edit_element` follow the app's editing model, so an LLM edit
and a human edit mean the same thing: the app stores a cleared optional scalar as
`null` (never `""`, never a missing key) and an emptied list as `[]`.

For every editing tool, invalid results are findings, not errors, so an edit may
leave a document transiently invalid — including a duplicate id, which the model
can hold. The exception is a value the model cannot represent at all (an unknown
datatype, a malformed enumeration or precondition): `from_json` rejects those
outright, so they raise `ValueError` naming the element and the offending change.
They all share that tail (`core._apply`), so they cannot drift apart.

### Sessions (phase 2)

`open_dictionary` hands a document to the server to hold and returns a
`sessionId`; pass that instead of `content` to any editing or query tool, and
`close_dictionary` gives the final document back.

The point is traffic. Measured over stdio, five edits on a 60-element dictionary:

| | bytes | ~tokens |
| --- | --- | --- |
| stateless (`content` each call) | 360 KB | 90k |
| session (`session_id`) | 37 KB | 9k |

Both produce a byte-identical final document — the tests assert it. Two things
make the saving real: a session reply carries a summary rather than the document,
and it carries a **findings digest** rather than every finding. That second part
matters more than it sounds: a 60-element dictionary has 60 `missing-unit` INFO
findings, which dwarfed the ~100-byte summary they were attached to. So `errors`
comes back in full (capped at 10, with `errorsOmitted`) and everything else as
counts by check. `validate_dictionary(session_id=...)` still gives the full list.

Sessions are in-memory and process-scoped, with no expiry: a document a client is
editing must not evaporate mid-conversation, and for a stdio server the process
*is* the conversation. `close_dictionary` is how a session ends.

Stateless mode is unchanged and remains the right choice for a single edit —
there is nothing to open or close, and one call costs no more either way.

### `compact`

Every tool that returns a document takes `compact` (and so does `export`, for
dd-json). It omits fields that are null or empty — **about half the bytes** on a
typical dictionary, measured on a 60-element one: 28.5 KB → 14.0 KB.

It is lossless and every tool accepts it as input, so it is the cheaper way to
carry a document across several calls in a stateless conversation: the omitted
fields are exactly the ones `load` fills back in, and editing a compact document
gives the same result as editing the full form. Findings are unaffected — they
come from the CSV serialisation either way.

The default is the full form, deliberately: the app writes every field on every
element, so a file destined for disk should match it.
