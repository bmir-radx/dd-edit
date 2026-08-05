# Working on data dictionaries with an AI assistant

The dd-edit MCP server lets an assistant — Claude Desktop, Claude Code, or any
other [MCP](https://modelcontextprotocol.io) client — read, check and author
[RADx data
dictionaries](https://github.com/bmir-radx/radx-data-dictionary-specification).

This is the task-oriented guide: set it up, use it, understand what it refuses to
do. For the tool-by-tool reference see
[../mcp-server/README.md](../mcp-server/README.md); for why it is built the way it
is, [MCP-DESIGN.md](MCP-DESIGN.md).

It runs independently of the dd-edit app. Nothing needs to be open, and the
assistant works on files or on dictionaries it builds from nothing.

## Setup

```bash
cd mcp-server
python -m venv .venv
.venv/bin/pip install -e ../core     # not on PyPI — a path dependency
.venv/bin/pip install -e .
```

Then point your client at it. For **Claude Desktop**, in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "dd-edit": {
      "command": "/absolute/path/to/dd-edit/mcp-server/.venv/bin/python",
      "args": ["-m", "dd_edit_mcp.server"]
    }
  }
}
```

For **Claude Code**, `claude mcp add` with the same command and args.

Use an absolute path to the venv's Python. The server needs that interpreter, not
whichever one the client happens to have.

To let the assistant save files, add a root — see [Saving](#saving-to-disk):

```json
"args": ["-m", "dd_edit_mcp.server", "--save-root", "/Users/you/dictionaries"]
```

Restart the client and ask it what dd-edit tools it has. Fifteen is the current
number.

## A worked example

What follows is a real session, lightly condensed: authoring a publications
dictionary from scratch. It shows the shape of the work rather than a script to
copy — you talk to the assistant, and it calls the tools.

### Start a session

For more than one or two edits, the assistant should call `open_dictionary`
first. The server then holds the document and each edit sends only what changed:

> **You:** I want to create a data dictionary about journal publications.

The assistant opens an empty document and gets back a handle:

```json
{"sessionId": "s1", "revision": 0, "elementCount": 0, "valid": true}
```

Every subsequent edit returns a summary like that rather than the whole
dictionary. On a 60-element dictionary the difference is ~16k tokens per edit
against a few hundred — see *Sessions* in the server README for the measurements.

### Add elements

> **You:** Add DOI, title, authors and journal, with the DOI required and
> pattern-checked.

The assistant calls `add_element` once per field. Each reply says whether the
document is still valid, so a mistake surfaces immediately rather than at the end:

```json
{"sessionId": "s1", "revision": 4, "elementCount": 4, "valid": true,
 "errorCount": 0, "warningCount": 0}
```

Worth asking for explicitly, because the assistant will otherwise guess:

- **`cardinality`** — `multiple` for authors, funders, anything repeating. It
  matters for more than storage: the precondition operator `contains` only works
  on multi-valued fields.
- **`unit`** for numeric fields. A count is legitimately unitless — the UCUM
  spelling for that is `1`, not blank.
- **`enumeration`** for coded fields, as `[{value, label}]`. Codes can be strings
  (`"pubmed"`) or integers (`"1"`); the toolkit does not care, your downstream
  tooling might.

### Check as you go

> **You:** Is it valid?

`validate_dictionary` gives the full findings list. `describe_dictionary` gives
the shape:

```json
{"elementCount": 22, "sections": ["Identifiers", "Bibliographic", "Classification",
 "Access", "Metrics", "Provenance"], "datatypes": {"string": 15, "date": 3,
 "boolean": 1, "integer": 3}, "valid": true, "errorCount": 0, "warningCount": 0}
```

Findings are advisory, not blocking. A document mid-edit is allowed to be
invalid — including a duplicate id — so the assistant can make a mess and fix it.
The exception is a value the model cannot represent at all (an unknown datatype, a
malformed enumeration or precondition); those are hard errors naming the element.

### Attach ontology terms

> **You:** Can you add ontology term IRIs to the enums?

The assistant searches a terminology service, then **verifies each IRI with
`lookup_terms` before writing it**. This matters: an assistant asked for ontology
terms will otherwise produce IRIs that look right and do not resolve.

```json
{"labels": {"http://id.nlm.nih.gov/mesh/D016454": "Review"}, "unresolved": []}
```

Anything in `unresolved` did not resolve — it may be retired, private, or
invented. Ask the assistant to drop those rather than keep them.

Expect partial coverage and be suspicious of full coverage. In the real session
behind this guide, publication types mapped cleanly to MeSH and NIH institutes
mapped to NCIT, but licences, citation databases and record sources had no
ontology terms at all — and NCIT's NIH branch still carries a pre-2014 name for
one institute, so mapping it would have asserted a superseded concept. An
assistant that maps *everything* is probably inventing.

### Export or save

```
export       → returns the serialised text (CSV / LinkML YAML / dd-json)
save_dictionary → writes the file, returns only a summary
```

Prefer `save_dictionary` when the goal is a file. `export` sends the whole
document to the assistant, which then sends it back through a write tool — the
dictionary crosses the wire twice. Measured across seven saves of a 22-element
dictionary: **~50.7k tokens that way, ~450 with `save_dictionary`.**

Use `export` when the assistant genuinely needs to *see* the output — to show you
a preview, or to check the serialisation.

## Sessions, and when to skip them

| | Use |
| --- | --- |
| One edit, one question | pass `content` directly — nothing to open or close |
| Several edits in a row | `open_dictionary`, then `session_id` everywhere |

Sessions live in the server process, with no expiry. Two consequences:

- **Restarting the client kills them.** If the connection drops, session handles
  are gone; `list_sessions` returns empty and the assistant must re-open from the
  file. Anything not saved is lost.
- **`close_dictionary` returns the final document**, so a session can end by
  handing the dictionary back rather than by saving it.

Ask the assistant to save at meaningful points rather than only at the end.

## Saving to disk

**The server cannot write files unless you start it with `--save-root DIR`.**
Without that flag, `save_dictionary` is listed but refuses:

```
saving is not enabled on this server — start it with --save-root DIR to allow
save_dictionary, or use export and write the file yourself
```

That is deliberate. Every other tool is text in, text out, which is what makes
them safe to expose to any client. Writing files is a different kind of
capability, so it is your decision and your directory.

With a root set, paths are confined to it. An absolute path elsewhere, a `..`
path, and a symlinked destination are all refused; relative paths resolve against
the root. One limit worth knowing: a symlinked *directory* inside the root is
followed, so the root should be somewhere only you can write.

Format comes from the extension — `.csv`, `.yaml`/`.yml`, `.json` — or pass `to`
to override. An unrecognised extension is refused rather than guessed.

### If you also have the file open in dd-edit

Two editors on one document is a real hazard, and the tooling only partly covers
it. The app offers to reload a file that changed on disk, and `save_dictionary`
accepts an `expect_sha256` digest so a write is refused if the file moved
underneath it. Neither is a merge.

The safe pattern is to let one side own the file at a time: finish in the app,
then ask the assistant; or let it save, then reload in the app.

## What it will not do

Worth knowing before you hit it:

- **Preconditions cannot express substring matching.** `contains` is set
  membership over a multi-valued field's values — `funder contains "NIH"` asks
  whether `NIH` is one of the entries, not whether any entry contains those
  letters. There is no substring operator in the grammar; `matches`, `like` and
  `~` are parse errors, and `pattern` constrains a field's own values rather than
  another field's. If you need "show this when notes mentions fever", the honest
  answer is that the specification cannot say it. *(This one is from experience:
  a precondition was built on the wrong reading, parsed, validated, and could
  never have matched.)*
- **REDCap branching logic is dropped, not translated.** `import_redcap` converts
  fields and enumerations; the branching grammar is not the precondition grammar,
  and a guessed translation would be wrong in ways nobody would notice.
- **Renaming does not rewrite references.** `edit_element` with `{"id": ...}`
  leaves a precondition mentioning the old id dangling — it surfaces as an
  `unknown-precondition-field` error. The app behaves the same way. Check the
  findings after a rename.
- **No HTML rendering.** That is the app's job.

## Getting good results

- **Ask it to validate**, and ask what the findings *mean*. Zero errors with
  thirty INFO findings is a different document from zero of each.
- **Question full ontology coverage** — see above.
- **Ask why**, not just what. A field held as a string rather than an integer
  usually has a reason (PMIDs are accession numbers, volumes can be `S1`); if the
  assistant cannot give one, it guessed.
- **Have it save before you close the client**, since sessions do not survive.
- **Check the enumeration codes** against whatever consumes the data. The toolkit
  accepts both `"pubmed"` and `"1"`; your analysis pipeline may not.
