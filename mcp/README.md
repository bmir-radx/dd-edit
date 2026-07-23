# dd-edit-mcp

An [MCP](https://modelcontextprotocol.io) server exposing RADx data-dictionary
tools to an LLM. Design: [../docs/MCP-DESIGN.md](../docs/MCP-DESIGN.md).

**Status: phase-1 spike.** One tool, `validate_dictionary`. It proves the
`dd-*` toolkit runs standalone (outside the app's FastAPI sidecar) and that the
MCP stdio plumbing works end to end. The full planned tool inventory
(query, author/edit) is in the design doc.

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

| Tool | Purpose |
| --- | --- |
| `validate_dictionary` | Validate a dictionary (dd-json / LinkML / CSV, auto-detected); returns `{detected, valid, findings}`. |
