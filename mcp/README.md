# dd-edit-mcp

An [MCP](https://modelcontextprotocol.io) server exposing RADx data-dictionary
tools to an LLM. Design: [../docs/MCP-DESIGN.md](../docs/MCP-DESIGN.md).

**Status: phase-1 tool inventory complete** except `render_html`, which the design
doc rates low priority (a human-facing artifact, arguably the app's job). Eleven
tools covering validate, query, and author. All stateless: every tool takes the
document it works on, so nothing assumes a single global document — the one
assumption a phase-2 session model would contradict.

The element-editing set — `add_element`, `edit_element`, `remove_element`,
`reorder_elements` — is uniform: pure `(document, op) → (document, findings)`,
sharing one round-trip tail (`core._apply`), ready for a session layer to wrap
unchanged (phases 2–3 in the design doc).

`lookup_terms` is the exception to "pure and offline": it queries OLS4 over the
network. The suite stubs it, so `pytest` stays deterministic; `pytest -m live`
runs the one test that really goes out.

## Layout

```
mcp/
├── pyproject.toml          # dd-* pinned to a released tag (in step with the sidecar)
├── dd_edit_mcp/
│   ├── core.py             # pure ops over the toolkit — no FastAPI, no MCP
│   └── server.py           # FastMCP stdio server; wraps core in tools
└── tests/test_server.py    # core directly + a protocol round-trip
```

`core.py` is deliberately transport-free: the same functions the app's sidecar
uses, factored so an MCP server sits on top. Editing tools (phase 2+) will be
pure `(document, op) → (document, findings)` so a session layer can wrap them
unchanged.

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

Note this package directory is itself named `mcp/`, so it shadows the `mcp`
library for tools that put the *parent* directory on `sys.path` — `uv run` from
the repo root fails with `No module named 'mcp.server...'`. The venv invocations
above are unaffected; run pytest from this directory (or an absolute path).

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
| `validate_dictionary` | validate | Findings for a dictionary; returns `{detected, valid, findings}`. |
| `list_elements` | query | Element summaries `{id, label, datatype, section}`, filterable by section / datatype / missing field. |
| `get_element` | query | Full detail for one element by id; `{found, element}`. |
| `describe_dictionary` | query | Summary: `{elementCount, sections, datatypes, valid, errorCount, warningCount}`. |
| `export` | query | Serialise to `csv` / `linkml` / `json`; `{format, content}`. |
| `add_element` | author | Insert an element (order-aware via `index`); returns `{document, valid, findings}`. Pure — the input is not modified. |
| `edit_element` | author | Change fields on one element by id; returns `{document, valid, findings}`. Pure. Omitted key = leave alone, `null` = clear, `{"id": ...}` = rename. |
| `remove_element` | author | Delete one element by id and/or index; returns `{document, valid, findings}`. Pure. Refuses an ambiguous (duplicated) id rather than guessing. |
| `reorder_elements` | author | Reorder elements; takes every id in the wanted order. Pure. Refuses anything but an exact permutation, so it cannot silently drop an element. |
| `import_redcap` | author | REDCap export CSV → dd-json; `{document, elementCount, valid, findings}`. Creates a document rather than editing one. Branching logic is dropped, not translated. |
| `lookup_terms` | query | Resolve term IRIs → labels; `{labels, unresolved}`. **The only tool that uses the network** (OLS4). Unresolved terms are absent, not errors. |

Patch semantics for `edit_element` follow the app's editing model, so an LLM edit
and a human edit mean the same thing: the app stores a cleared optional scalar as
`null` (never `""`, never a missing key) and an emptied list as `[]`.

For both editing tools, invalid results are findings, not errors, so an edit may
leave a document transiently invalid — including a duplicate id, which the model
can hold. The exception is a value the model cannot represent at all (an unknown
datatype, a malformed enumeration or precondition): `from_json` rejects those
outright, so they raise `ValueError` naming the element and the offending change.
Both tools share that tail (`core._apply`), so they cannot drift apart.
