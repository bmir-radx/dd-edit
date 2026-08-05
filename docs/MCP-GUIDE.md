# Working on data dictionaries with an AI assistant

This readme describes how to install and use the data dictionary MCP (Model
Context Protocol) server. It lets an AI assistant — such as Claude, Codex or
ChatGPT — read, check, create and write
[data dictionaries](https://github.com/bmir-radx/radx-data-dictionary-specification).

The server is designed to work in a complementary fashion to the dd-edit app. It uses the same specification libraries as the app, so a dictionary the
assistant writes opens in dd-edit.

## Setting it up

The server is fetched and run on demand. All that is needed is a Python tool
launcher — either [uv](https://docs.astral.sh/uv/) or
[pipx](https://pipx.pypa.io), whichever you already have. Neither is better here;
`uv` is faster on a cold start, `pipx` is packaged in most Linux distributions.

Every MCP client needs the same two things: a command to run, and the arguments to
run it with. With `uv` those are

```
command:  uvx
args:     --from git+https://github.com/bmir-radx/dd-edit.git#subdirectory=mcp-server
          dd-edit-mcp
```

and with `pipx`

```
command:  pipx
args:     run
          --spec git+https://github.com/bmir-radx/dd-edit.git#subdirectory=mcp-server
          dd-edit-mcp
```

Only the way they are entered differs from one client to the next. Whichever you
use, restart it afterwards and then ask the assistant what dd-edit tools it has:
if it lists them, the server is connected.

The first run is slow, since the server pulls in a hundred-odd packages, and under
pipx's default backend that can take several minutes. Later runs start from cache
in well under a second. A client that gives up the first time is hitting its own
startup timeout, so run the command once in a terminal to warm the cache and then
restart it.

### Claude Desktop

Open Settings, then Developer, then Edit Config, and add a `dd-edit` entry under
`mcpServers`. On a Mac that file is
`~/Library/Application Support/Claude/claude_desktop_config.json`, and editing it
directly works just as well:

```json
{
  "mcpServers": {
    "dd-edit": {
      "command": "uvx",
      "args": ["--from",
               "git+https://github.com/bmir-radx/dd-edit.git#subdirectory=mcp-server",
               "dd-edit-mcp"]
    }
  }
}
```

For pipx, the same entry with `"command": "pipx"` and `"args": ["run", "--spec",
…]` in the order shown above. Quit and reopen Claude Desktop for it to take
effect; restarting the window is not enough.

### Claude Code

```bash
claude mcp add dd-edit -- uvx \
  --from "git+https://github.com/bmir-radx/dd-edit.git#subdirectory=mcp-server" \
  dd-edit-mcp
```

That registers the server for yourself in the current project. Add `--scope user`
to make it available in every project instead, or `--scope project` to share it
with anyone working in the repository. `claude mcp list` shows what is registered
and health-checks it.

### Other clients

Codex takes the same shape:

```bash
codex mcp add dd-edit -- uvx \
  --from "git+https://github.com/bmir-radx/dd-edit.git#subdirectory=mcp-server" \
  dd-edit-mcp
```

For anything else, consult its own documentation for where the configuration
lives. The command and arguments are the part that does not change.

<details>
<summary>Alternative: install from a clone (for development)</summary>

Work on the server itself needs it installed in place, so that edits take effect
on the next client restart rather than being pinned to whatever is on GitHub:

```bash
cd mcp-server
python -m venv .venv
.venv/bin/pip install -e ../core     # not on PyPI, so install it by path first
.venv/bin/pip install -e .
```

The command and arguments then become the venv's own interpreter:

```
command:  /absolute/path/to/dd-edit/mcp-server/.venv/bin/python
args:     -m dd_edit_mcp.server
```

The path has to be absolute, as the client will not have the venv on its `PATH`.

</details>

## What you can ask for

Ordinary requests, in your own words:

> *"Create a data dictionary for our publications — DOI, title, authors, journal,
> publication date."*

> *"Import this REDCap export and tell me what's missing."*

> *"Which fields have no unit?"*

> *"Change publication_type to use numeric codes instead of strings."*

> *"Add ontology term IRIs to the enumerations where real ones exist."*

> *"Is this valid? What would a reviewer complain about?"*

> *"Save it as publications.dd.csv, and give me a LinkML version too."*

Dictionaries can be created from nothing or opened from an existing file in CSV,
LinkML YAML or dd-json.

## A short example

> **You:** I want to create a data dictionary about journal publications.
>
> **Assistant:** *(starts a working copy)* What subject matter, and do you have an
> existing source to import?
>
> **You:** No source. Publications metadata — identifiers, bibliographic details,
> open access status, citation counts.
>
> **Assistant:** *(adds fields one at a time, checking after each)* I've added 22
> fields across six sections. It validates with no errors or warnings.
>
> Some choices worth your review: PMIDs and volumes are held as text rather than
> numbers, because they're accession numbers and can carry values like "S1".
> Citation count has two companion fields — a source and a retrieval date — since
> a bare count isn't interpretable without them.
>
> **You:** Add ontology term IRIs to the enums.
>
> **Assistant:** Publication types map cleanly to MeSH and NIH institutes to
> NCIT — 28 terms, each one verified. Licences, citation databases and record
> sources have no ontology terms at all, so I've left those unmapped rather than
> invent IRIs.
>
> **You:** Save it as publications.dd.csv.
>
> **Assistant:** Written — 22 elements, 12,006 bytes, validates clean.

A good assistant reports the choices it made and why, rather than only that it
finished.

## Saving your work

Ask the assistant to save and it writes the file. Give it a path or let it propose
one. The format follows the extension, so `publications.dd.csv` and
`publications.dd.yaml` give you a data dictionary CSV and a LinkML YAML of the
same dictionary. The MCP client asks before it runs the tool, so nothing is
written without your say-so.

Having the same file open in dd-edit makes two editors of one document, and work
can be lost that way, since neither side merges edits. It is safest for one to own
the file at a time: finish in the app and then hand it over, or let the assistant
save and then reload in the app.

An assistant running unattended, on a schedule or in a pipeline, has no client
prompting a human before each call. Starting the server with `--save-root` bounds
every save to one directory and refuses a request to write anywhere else:

```
dd-edit-mcp --save-root /Users/you/dictionaries
```

Add that wherever the command is configured. For interactive use it is
unnecessary.

## Getting good results

Ask the assistant to check its work, and ask what the findings mean rather than
only whether the dictionary is valid: a document that validates with thirty
informational notes is a different thing from one with none.

Ontology coverage is patchy, so be suspicious if every enumeration comes back with
a term attached. Clinical and bibliographic concepts are often well covered, while
organisations, licences and database names frequently are not, and an assistant
that maps everything is probably inventing identifiers that look plausible and do
not resolve. Asking which ones it verified is usually enough to tell.

It is worth asking why as well as what. There is generally a reason a field is
text rather than a number, or a value is coded 99 rather than 9, and an assistant
that cannot give one has guessed.

Ask it to save at milestones rather than only at the end. The working copy lives
as long as the connection does, and a client restart discards anything unsaved.

Finally, say what the downstream tooling needs. The specification accepts both
text codes such as `pubmed` and numeric ones such as `1`, but an analysis pipeline
reading the data may not.

## Things it cannot do

A conditional field cannot test for text inside another field. It can say "only
when funder is NIH", but not "only when the notes mention fever", because the
specification has no way to express a partial text match and there is no
workaround short of changing the specification itself. Asked for one, a good
assistant will say so rather than build a condition that quietly never triggers.

Importing a REDCap export brings across the fields and their answer options, but
not the branching logic. Those show-this-if rules use a different grammar, and a
guessed translation would look right and be wrong.

Renaming a field does not update references to it. A condition mentioning the old
name is left dangling and shows up as an error the next time the dictionary is
checked, which is how dd-edit behaves too.

There is no rendered HTML preview. That is the app's job.

---

## Notes

Detail that is not needed to use the server, but explains behaviour that can look
odd from the outside.

**Working copies.** For a run of edits the assistant hands the dictionary to the
server to hold rather than carrying it back and forth. That is why it can make
twenty changes without re-reading the file each time, and also why unsaved work
disappears if the connection drops: the copy lives in that process and there is no
autosave.

**Why saving directly is cheaper.** Asking the assistant to display a dictionary
so it can be saved by hand sends the whole document twice, out to the assistant
and back again, whereas letting it save sends neither copy. Across seven saves of
a 22-element dictionary that came to about 450 tokens rather than 50,700.

**How `--save-root` is enforced.** The path is resolved before it is checked, so a
path using `..`, an absolute path elsewhere, and a symbolic link pointing outside
are all refused. A symlinked directory inside the allowed folder is followed
though, so an unattended agent's root should be somewhere only you can write.

**Two editors, partly guarded.** dd-edit offers to reload a file that changed on
disk, and the server can be given the digest of the file it expects to overwrite
and refuse the write if that no longer matches. Both catch the collision, but
neither resolves it.

**File formats.** Saving picks the format from the extension, one of `.csv`,
`.yaml` or `.yml`, and `.json`. An unfamiliar extension is refused rather than
guessed at.

**Transient invalidity is fine.** A dictionary mid-edit is allowed to be broken,
two fields sharing an id included, so the assistant can rearrange things and then
fix them. A few values are rejected outright rather than recorded as problems: an
unknown datatype, or a malformed enumeration or condition. Those come back as
errors naming the field.

**Ontology lookups reach the network.** Everything else works offline. A term that
does not resolve comes back as unresolved rather than as an error, since it may be
retired, private, or simply mistyped.

**The word "contains".** In the specification's condition grammar, `contains` asks
whether a multi-valued field holds a given value among its values, which is set
membership rather than the substring matching the word suggests in English. The
distinction matters because a condition written on the wrong reading parses
cleanly, validates cleanly, and can never match anything.

---

Tool-by-tool reference: [../mcp-server/README.md](../mcp-server/README.md).
Design and rationale: [MCP-DESIGN.md](MCP-DESIGN.md).
