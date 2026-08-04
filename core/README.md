# dd-edit-core

The shared, transport-free data-dictionary core for dd-edit: format detection,
multi-format loading, and validation over the `dd-*` toolkit. No FastAPI, no MCP.

Both the app's Python sidecar (`../sidecar`) and the MCP server (`../mcp-server`) depend
on this, so they agree on how a dictionary parses and validates rather than each
keeping its own copy. Feature-detection against the pinned toolkit release
(duplicate-id handling, LinkML emit options) lives here, so a toolkit bump is
reconciled in one place.

## API

| Name | Purpose |
| --- | --- |
| `detect(text)` | format of the input: `"json"` \| `"linkml"` \| `"csv"` |
| `load(text)` | parse any supported format → toolkit `DataDictionary` |
| `validate_document(text)` | findings for a dictionary in any format |
| `findings_from_csv(csv)` | adapt the validator's findings for a CSV serialization |
| `Finding` | one finding (`.as_dict()` for the wire shape) |
| `LINKML_OPTIONS`, `ALLOW_DUPLICATE_IDS`, `KEEP_DUPLICATES` | feature-detected toolkit knobs |

## Develop

```bash
python -m venv .venv
.venv/bin/pip install -e ".[test]"
.venv/bin/pytest
```
