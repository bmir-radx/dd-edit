# dd-edit-mcp

An [MCP](https://modelcontextprotocol.io) server exposing RADx data-dictionary
tools to an LLM. Design: [../docs/MCP-DESIGN.md](../docs/MCP-DESIGN.md).

**Status: phase-1 tool inventory complete.** Six tools covering the three
phase-1 use cases — validate, query, and author. All stateless: pure functions
over a document passed in each call. The editing tool (`add_element`) uses the
`(document, op) → (document, findings)` shape that must survive into the later
session/live-app phases (phases 2–3 in the design doc).

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
.venv/bin/pip install -e ".[test]"
.venv/bin/pytest
```

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
