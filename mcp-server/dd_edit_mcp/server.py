"""dd-edit MCP server (phase 1).

Exposes data-dictionary capabilities to an MCP client over stdio: validate,
query, and author. Each tool is a thin wrapper adding the MCP-facing docstring
and result shape over a pure function in core; see docs/MCP-DESIGN.md for the
full planned inventory and the phase plan.

The tool docstrings are the product surface — an LLM has to use these tools
without reading the source, so they carry the semantics (what is required, what
raises vs. what comes back as a finding) rather than deferring to core.

Run:  python -m dd_edit_mcp.server      (stdio; wire into an MCP client)
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

from mcp.server.mcpserver import MCPServer

from dd_edit_mcp import core
from dd_edit_mcp.sessions import SessionStore

try:
    _VERSION = version("dd-edit-mcp")
except PackageNotFoundError:  # running from a source tree, not installed
    _VERSION = "0.0.0+unknown"

mcp = MCPServer("dd-edit", version=_VERSION)

# Phase-2 session state. One store per server process; a stdio server serves one
# client, so this is that client's set of open documents.
sessions = SessionStore()


def _document(content: str, session_id: str) -> str:
    """Resolve the two ways a tool can be handed a document.

    Every document-taking tool accepts either an inline `content` or a
    `session_id`. Requiring exactly one keeps the ambiguous cases — both, or
    neither — from being silently resolved in a way the caller did not intend.

    Both are annotated plain `str` with "" meaning absent, deliberately: the SDK
    pre-parses a string argument into JSON whenever the annotation is not exactly
    `str` (func_metadata.pre_parse_json), so `str | None` would turn a dd-json
    document into a dict before the tool ever saw it.
    """
    if bool(content) == bool(session_id):
        raise ValueError(
            "pass either content (an inline document) or session_id "
            "(an open session), not both and not neither"
        )
    if session_id:
        return sessions.get(session_id).document
    return content


def _findings_digest(findings: list, limit: int = 10) -> dict:
    """Findings for a session reply: the errors, and counts for the rest.

    A session exists so a reply does not scale with the document, and findings do
    — a 60-element dictionary can easily carry 60 INFO findings, which dwarfed the
    100-byte summary they were attached to. So return the ERRORs (what a caller
    must act on), capped, plus counts by check for everything else. The full list
    is always a `validate_dictionary(session_id=...)` call away.
    """
    errors = [f for f in findings if f.level == "ERROR"]
    by_check: dict[str, int] = {}
    for finding in findings:
        if finding.level != "ERROR":
            by_check[finding.check] = by_check.get(finding.check, 0) + 1
    digest = {
        "errors": [f.as_dict() for f in errors[:limit]],
        "otherFindings": by_check,
    }
    if len(errors) > limit:
        digest["errorsOmitted"] = len(errors) - limit
    return digest


def _edit(
    content: str,
    session_id: str,
    operation,
    *,
    extra: dict | None = None,
) -> dict:
    """Run an editing operation in whichever mode the caller asked for.

    `operation` is a core editing function with everything but the document bound.
    Session mode keeps the result server-side and returns a summary; stateless
    mode returns the new document, as it always has. The two share this one path
    so an edit cannot mean different things in the two modes.
    """
    if bool(content) == bool(session_id):
        raise ValueError(
            "pass either content (an inline document) or session_id "
            "(an open session), not both and not neither"
        )

    if session_id:
        # Session mode: the held document is the input, and the result stays
        # server-side. compact is irrelevant — no document is returned.
        session = sessions.apply(session_id, operation)
        return {
            **session.summary(),
            **_findings_digest(session.findings),
            **(extra or {}),
        }

    result = operation(content)
    return {
        "document": result.document,
        "valid": not any(f.level == "ERROR" for f in result.findings),
        "findings": [f.as_dict() for f in result.findings],
        **(extra or {}),
    }


@mcp.tool()
def open_dictionary(content: str) -> dict:
    """Hand a dictionary to the server to hold, and get a session id back.

    Use this when you are about to make **several** edits. The server keeps the
    authoritative copy, so each edit sends only what changed and returns only a
    summary — instead of shipping the whole document in and out every time. On a
    60-element dictionary that is the difference between ~16k tokens per edit and
    a few hundred.

    It also removes a failure mode: when you carry the document yourself, every
    round-trip is a chance to paraphrase or drop a field. The held copy cannot
    drift.

    Pass `session_id` to the editing and query tools instead of `content`. When
    you are done, `close_dictionary` returns the final document to save. For a
    single edit, skip all this and pass `content` directly — stateless is simpler
    and costs nothing extra for one call.

    Args:
        content: The dictionary to open (dd-json, LinkML YAML, or CSV,
            auto-detected). It is validated on open, so the findings tell you what
            you are starting from.

    Returns:
        A dict with:
          - sessionId: the handle to pass to other tools
          - revision: 0 — increments on each applied edit
          - elementCount, valid, errorCount, warningCount: what you opened
          - errors: the ERROR-level findings (capped at 10; `errorsOmitted` says
            how many more), and otherFindings: counts by check for the rest. A
            session reply stays small on purpose — call
            `validate_dictionary(session_id=...)` for the full list.
    """
    # Normalise on the way in: the session holds dd-json, so a CSV or LinkML input
    # is converted once here rather than on every subsequent edit.
    document = core.export(content, "json")
    findings = core.validate_document(content)
    session = sessions.open(document, findings)
    return {**session.summary(), **_findings_digest(findings)}


@mcp.tool()
def close_dictionary(session_id: str, compact: bool = False) -> dict:
    """Close a session and return its final document.

    The document is only in the server's memory, so this is how you get it back to
    save it. After this the session id is dead.

    Args:
        session_id: The session to close.
        compact: Return the document with null/empty fields omitted. Leave false
            for a file to save, since the app writes the full form.

    Returns:
        A dict with:
          - document: the final dictionary as dd-json text
          - revision: how many edits were applied
          - elementCount, valid, errorCount, warningCount
          - errors / otherFindings: the digest from the last operation (see
            `open_dictionary`)
    """
    session = sessions.close(session_id)
    document = (
        core.export(session.document, "json", compact=True)
        if compact
        else session.document
    )
    return {
        **session.summary(),
        "document": document,
        **_findings_digest(session.findings),
    }


@mcp.tool()
def list_sessions() -> dict:
    """List the dictionaries the server is currently holding.

    Useful if you have lost track of a session id, or to check what is still open
    before finishing. Sessions last until closed or until the server restarts.

    Returns:
        {count, sessions: [{sessionId, revision, elementCount, valid,
        errorCount, warningCount}, ...]}
    """
    open_sessions = sessions.list()
    return {"count": len(open_sessions), "sessions": open_sessions}


@mcp.tool()
def validate_dictionary(
    content: str = "", session_id: str = ""
) -> dict:
    """Validate a RADx data dictionary and return findings.

    Accepts a data dictionary in any of the toolkit's formats — dd-json,
    LinkML YAML, or the data-dictionary CSV — auto-detected from the content.
    Returns validation findings (errors and warnings) such as duplicate ids,
    unknown datatypes, missing units, or malformed enumerations. A valid
    document returns an empty findings list.

    Findings never raise: a well-formed but invalid document (e.g. a duplicate
    id) comes back as findings, not an error. Only input the parser cannot load
    at all raises.

    Checks worth knowing by name, because they are the ones an edit tends to
    trip: `duplicate-id`; `unknown-datatype`; `missing-unit` (a numeric field
    with no UCUM unit); and the precondition family —
    `malformed-precondition` (syntax), `unknown-precondition-field` (refers to a
    field that is not in the dictionary — what a rename or a removal leaves
    behind), `invalid-precondition-comparison` (an ordering operator on an
    unordered datatype), `invalid-precondition-contains` (`contains` on a
    single-valued field), and the `precondition-value-*` warnings (a literal that
    does not fit the field's datatype or enumeration). The precondition grammar
    is documented under `edit_element`.

    Args:
        content: The data dictionary text (dd-json, LinkML YAML, or CSV).
        session_id: An open session from `open_dictionary`, instead of `content`.
            Pass exactly one of `content` or `session_id`.

    Returns:
        A dict with:
          - detected: the format that was detected ("json" | "linkml" | "csv")
          - valid: true if there are no ERROR-level findings
          - findings: list of {level, check, message, line, column, value,
            elementIndex, elementId, suggestion}
    """
    document = _document(content, session_id)
    findings = core.validate_document(document)
    return {
        "detected": core.detect(document),
        "valid": not any(f.level == "ERROR" for f in findings),
        "findings": [f.as_dict() for f in findings],
    }


@mcp.tool()
def add_element(
    element: dict,
    content: str = "",
    session_id: str = "",
    index: int | None = None,
    compact: bool = False,
) -> dict:
    """Add a data element to a dictionary; return the updated document + findings.

    Inserts a new element and returns the whole updated dictionary as dd-json,
    together with fresh validation findings so you can see immediately whether
    the addition introduced any problems (e.g. a duplicate id, an unknown
    datatype). The input is not modified; use the returned `document` as the
    input to further edits.

    Element order is meaningful — it is the field order in the target data file
    — so `index` controls where the new element goes; omit it to append.

    Most invalid results come back as findings, not errors, so you can add an
    element that leaves the document temporarily invalid (e.g. a duplicate id)
    and then fix it. The exception is a value the model cannot represent at all —
    an unknown datatype, a malformed enumeration or precondition — which is an
    error naming the element.

    Args:
        content: The current dictionary (dd-json, LinkML YAML, or CSV,
            auto-detected). The returned document is always dd-json.
        element: The new element as an object. `id` is required; `label`,
            `datatype` ("integer", "float", "string", …), and `cardinality`
            ("single" | "multiple") are strongly recommended. Other allowed
            keys: required, unit, description, section, enumeration,
            missing_value_codes, pattern, precondition, examples, notes,
            provenance, see_also, aliases, terms. Unknown keys are rejected.
            See "Field shapes" below for the ones that are not plain strings.
        index: 0-based position to insert at; omit to append at the end.
        compact: Return the document with null/empty fields omitted — roughly
            half the size on a typical dictionary, and accepted as input by every
            tool here, so it is the cheaper way to carry a document across
            several calls. Lossless. Leave false when producing a file to save.
        session_id: An open session from `open_dictionary`, instead of `content`.
            The edit applies to the held document and the reply is a summary
            (revision, counts, ERROR findings) rather than the whole dictionary —
            about a tenth of the traffic over a run of edits. Pass exactly one of
            `content` or `session_id`.

    Field shapes:
        enumeration, missing_value_codes: a list of code objects,
            `[{"value": "1", "label": "Male"}, …]` — `value` is the code stored
            in the datafile, `label` is what it means, and an optional `iri`
            links it to a term. An item with no `value` is silently dropped, and
            a list of bare strings (`["1", "2"]`) is silently dropped whole, so
            always send objects with a `value`.
        aliases, terms, examples: lists of plain strings. `terms` holds IRIs as
            strings (`["http://purl.org/…"]`) — objects are NOT accepted here and
            are silently mangled rather than rejected.
        precondition: a string in the grammar documented under `edit_element`.

    Returns:
        With `content`: {document, valid, findings} — the whole updated dictionary
        as dd-json. With `session_id`: {sessionId, revision, elementCount, valid,
        errorCount, warningCount, findings} — no document, since the server kept
        it; `close_dictionary` hands it back at the end.
    """
    return _edit(
        content,
        session_id,
        lambda doc: core.add_element(
            doc, element, index=index, compact=compact
        ),
    )


@mcp.tool()
def edit_element(
    element_id: str,
    changes: dict,
    content: str = "",
    session_id: str = "",
    compact: bool = False,
) -> dict:
    """Change fields on one element; return the updated document + findings.

    Edits a single element in place and returns the whole updated dictionary as
    dd-json, together with fresh validation findings so you can see immediately
    whether the edit introduced a problem. The input is not modified; use the
    returned `document` as the input to further edits.

    Only the fields you name change — everything else on that element, and every
    other element, is untouched. So a targeted edit needs only the changed
    fields, not the whole element:

        edit_element(content, "age", {"unit": "months"})

    To clear an optional field, pass null explicitly; to leave it alone, omit
    it. `{"unit": null}` removes the unit, whereas `{}` is rejected as a no-op.
    Clear a list-valued field with `[]`.

    Renaming is `{"id": "new_id"}`. Nothing else in the document is rewritten to
    follow the rename, so a reference elsewhere (e.g. a precondition naming the
    old id) can be left dangling — check the returned findings after a rename.

    Most invalid results come back as findings, not errors, so you can make an
    edit that leaves the document temporarily invalid and then fix it. The
    exception is a value the model cannot represent at all — an unknown datatype,
    a malformed enumeration or precondition — which is an error; the message
    names the element and the offending change.

    Args:
        content: The current dictionary (dd-json, LinkML YAML, or CSV,
            auto-detected). The returned document is always dd-json.
        element_id: The id of the element to change. If the id is duplicated,
            the first occurrence is edited.
        changes: An object of the fields to change. Allowed keys: id, label,
            datatype, cardinality, required, unit, description, section,
            enumeration, missing_value_codes, pattern, precondition, examples,
            notes, provenance, see_also, aliases, terms. Unknown keys are
            rejected. id, label, and datatype are required fields and cannot be
            cleared.
        compact: Return the document with null/empty fields omitted — roughly
            half the size on a typical dictionary, and accepted as input by every
            tool here, so it is the cheaper way to carry a document across
            several calls. Lossless. Leave false when producing a file to save.
        session_id: An open session from `open_dictionary`, instead of `content`.
            The edit applies to the held document and the reply is a summary
            (revision, counts, ERROR findings) rather than the whole dictionary —
            about a tenth of the traffic over a run of edits. Pass exactly one of
            `content` or `session_id`.

    Field shapes:
        enumeration, missing_value_codes: a list of code objects,
            `[{"value": "1", "label": "Male"}, …]` — `value` is the code stored
            in the datafile, `label` is what it means, and an optional `iri`
            links it to a term. These replace the whole list, so to add one code
            send the existing items plus the new one (read them with
            `get_element` first). An item with no `value` is silently dropped,
            and a list of bare strings (`["1", "2"]`) is silently dropped whole,
            so always send objects with a `value`.
        aliases, terms, examples: lists of plain strings, also replaced whole.
            `terms` holds IRIs as strings (`["http://purl.org/…"]`) — objects are
            NOT accepted here and are silently mangled rather than rejected.

    Precondition grammar:
        A `precondition` says when the field applies. It is a string in this
        grammar ("and" binds tighter than "or"):

            expression := clause (("and" | "or") clause)*
            clause     := predicate | "(" expression ")"
            predicate  := fieldId ("=" | "<>" | "<" | "<=" | ">" | ">=") literal
                        | fieldId "<>" ""            (i.e. the field is not blank)
                        | fieldId "in" "{" literal ("," literal)* "}"
                        | fieldId "contains" literal
            literal    := "quoted string" | bare numeral

        Examples: `age >= 18`, `sex = "1"`, `age >= 18 and sex <> "2"`,
        `race in {"1", "2", "3"}`, `symptoms contains "fever"`, `consent <> ""`.

        `contains` is **set membership, not substring matching**: it asks whether
        a multi-valued field (cardinality "multiple") includes a value among its
        values. There is no substring operator — a precondition cannot express
        "this text field mentions X", and `pattern` is not an alternative (it
        constrains a field's *own* values, not another field's). If a user asks for
        substring matching, say it is not expressible rather than reaching for
        `contains`.

        Rules the validator enforces, so check the findings: the field ids must
        exist in this dictionary; `<` `<=` `>` `>=` need an ordered (numeric or
        temporal) datatype; `contains` needs cardinality "multiple"; and a value
        compared against an enumerated field should be one of its codes.

        Note the asymmetry: a *malformed* precondition is rejected outright (the
        model cannot hold it), whereas the semantic problems above come back as
        findings on a document that was accepted.

    Returns:
        With `content`: {document, valid, findings} — the whole updated dictionary
        as dd-json. With `session_id`: {sessionId, revision, elementCount, valid,
        errorCount, warningCount, findings} — no document, since the server kept
        it; `close_dictionary` hands it back at the end.
    """
    return _edit(
        content,
        session_id,
        lambda doc: core.edit_element(
            doc, element_id, changes, compact=compact
        ),
    )


@mcp.tool()
def remove_element(
    element_id: str | None = None,
    index: int | None = None,
    content: str = "",
    session_id: str = "",
    compact: bool = False,
) -> dict:
    """Delete one element; return the updated document + findings.

    Removes exactly one element and returns the whole updated dictionary as
    dd-json, with fresh validation findings. The order of the remaining elements
    is preserved. The input is not modified; use the returned `document` as the
    input to further edits.

    Identify the element by `element_id`, by `index`, or both — passing both means
    "the element at this index, which must have this id", which is worth doing if
    you are working from a listing that might be stale.

    If several elements share the id, this refuses rather than guessing which you
    meant, and the error lists the matching positions so you can retry with
    `index`. (Duplicate ids are invalid but possible; other tools act on the first
    match, but a wrong deletion is not visible in the result the way a wrong edit
    is.)

    Deleting an element that others refer to — e.g. a `precondition` reading
    "age >= 18" when you delete `age` — leaves that reference dangling. The text
    is not rewritten; it comes back as an `unknown-precondition-field` ERROR in
    findings, so check them after removing anything referenced elsewhere.
    Removing the last element is allowed and leaves a valid empty dictionary.

    Args:
        content: The current dictionary (dd-json, LinkML YAML, or CSV,
            auto-detected). The returned document is always dd-json.
        element_id: The id of the element to remove.
        index: 0-based position of the element to remove. Use this to
            disambiguate a duplicated id, or on its own to remove by position.
        compact: Return the document with null/empty fields omitted — roughly
            half the size on a typical dictionary, and accepted as input by every
            tool here, so it is the cheaper way to carry a document across
            several calls. Lossless. Leave false when producing a file to save.
        session_id: An open session from `open_dictionary`, instead of `content`.
            The edit applies to the held document and the reply is a summary
            (revision, counts, ERROR findings) rather than the whole dictionary —
            about a tenth of the traffic over a run of edits. Pass exactly one of
            `content` or `session_id`.

    Returns:
        With `content`: {document, valid, findings} — the whole updated dictionary
        as dd-json. With `session_id`: {sessionId, revision, elementCount, valid,
        errorCount, warningCount, findings} — no document, since the server kept
        it; `close_dictionary` hands it back at the end.
    """
    return _edit(
        content,
        session_id,
        lambda doc: core.remove_element(
            doc, element_id, index=index, compact=compact
        ),
    )


@mcp.tool()
def reorder_elements(
    order: list[str],
    content: str = "",
    session_id: str = "",
    compact: bool = False,
) -> dict:
    """Reorder a dictionary's elements; return the updated document + findings.

    Changes only the sequence of the elements — nothing about any element itself.
    Element order is meaningful: it is the column order in the target data file,
    so this edits what the dictionary describes.

    `order` must list **every** element id exactly once, in the order you want.
    Get the current ids from `list_elements` first, then send the full list
    rearranged. A list that omits, repeats, or invents an id is rejected, and the
    error says which — so this cannot silently drop elements. To move one element,
    still send the whole list with that id in its new place.

    Reordering requires unique ids. If the dictionary has duplicates (invalid but
    possible), an id no longer identifies one element and this is rejected; fix
    the duplicates with `edit_element` first.

    Args:
        content: The current dictionary (dd-json, LinkML YAML, or CSV,
            auto-detected). The returned document is always dd-json.
        order: Every element id, in the desired order. Must be an exact
            permutation of the ids in the document.
        compact: Return the document with null/empty fields omitted — roughly
            half the size on a typical dictionary, and accepted as input by every
            tool here, so it is the cheaper way to carry a document across
            several calls. Lossless. Leave false when producing a file to save.
        session_id: An open session from `open_dictionary`, instead of `content`.
            The edit applies to the held document and the reply is a summary
            (revision, counts, ERROR findings) rather than the whole dictionary —
            about a tenth of the traffic over a run of edits. Pass exactly one of
            `content` or `session_id`.

    Returns:
        With `content`: {document, valid, findings} — the whole updated dictionary
        as dd-json. With `session_id`: {sessionId, revision, elementCount, valid,
        errorCount, warningCount, findings} — no document, since the server kept
        it; `close_dictionary` hands it back at the end.
    """
    return _edit(
        content,
        session_id,
        lambda doc: core.reorder_elements(doc, order, compact=compact),
    )


@mcp.tool()
def import_redcap(
    content: str,
    provenance: str = "",
    allow_duplicates: bool = False,
    compact: bool = False,
    open_session: bool = False,
) -> dict:
    """Convert a REDCap data-dictionary export into a dd-json dictionary.

    Takes a REDCap data dictionary (the CSV REDCap exports, with a
    "Variable / Field Name" column) and returns an equivalent RADx dictionary as
    dd-json, plus validation findings. Field types become datatypes and REDCap
    choices become enumerations.

    This is a starting point, not a finished dictionary — the findings are the
    to-do list. REDCap carries no units, so numeric fields typically come back
    with `missing-unit`, which you can fix with `edit_element`.

    REDCap's branching logic is deliberately **not** converted into a
    `precondition`: the grammars differ and a guessed translation would be wrong
    in ways nobody would notice. It is dropped, so re-add any conditions that
    matter.

    Args:
        content: The REDCap data-dictionary export, as CSV text.
        provenance: Fills every element's provenance — typically the study or
            instrument name. Worth setting: it is the only record of where these
            elements came from.
        allow_duplicates: REDCap multi-form exports often repeat a shared field on
            every form. Leave false to have a repeated variable name rejected; set
            true to keep the first occurrence and drop the rest — that loses data
            silently, so check `elementCount` against what you expected.
        compact: Return the document with null/empty fields omitted — roughly
            half the size on a typical dictionary, and accepted as input by every
            tool here, so it is the cheaper way to carry a document across
            several calls. Lossless. Leave false when producing a file to save.
        open_session: Keep the converted dictionary server-side and return a
            session id instead of the document. A converted REDCap dictionary
            usually needs a run of follow-up edits (units, descriptions), so this
            saves shipping it back and forth; `close_dictionary` returns it at the
            end. There is no `session_id` parameter here because this tool creates
            a document rather than editing an existing one.

    Returns:
        A dict with:
          - document: the converted dictionary as dd-json text
          - elementCount: how many elements it contains (check this when
            allow_duplicates is true)
          - valid: true if there are no ERROR-level findings
          - findings: list of findings (same shape as validate_dictionary)
    """
    result = core.import_redcap(
        content,
        provenance=provenance,
        allow_duplicates=allow_duplicates,
        # A session holds dd-json in one canonical form; only compact the
        # document when the caller is the one carrying it away.
        compact=compact and not open_session,
    )
    element_count = len(core.list_elements(result.document))

    # import_redcap has no input document, so a session_id parameter would make no
    # sense here — the choice is whether to keep the *output* server-side.
    if open_session:
        session = sessions.open(result.document, result.findings)
        return {**session.summary(), **_findings_digest(result.findings)}

    return {
        "document": result.document,
        "elementCount": element_count,
        "valid": not any(f.level == "ERROR" for f in result.findings),
        "findings": [f.as_dict() for f in result.findings],
    }


@mcp.tool()
def lookup_terms(terms: list[str], timeout: float = 15.0) -> dict:
    """Resolve ontology term IRIs to human-readable labels.

    Use this to check what a term in an element's `terms` field actually means, or
    to confirm an IRI is real before adding it. Unlike every other tool here, this
    one makes a network request (to OLS4), so it can be slow and needs
    connectivity.

    A term that does not resolve is simply **absent** from `labels` rather than
    being an error — it may be private, retired, or mistyped. Compare the keys you
    get back against what you sent to see which failed; `unresolved` lists them
    for you.

    Up to 100 terms per call (duplicates and blanks are ignored); send more in
    batches.

    Args:
        terms: Term IRIs to resolve, e.g.
            ["http://purl.obolibrary.org/obo/NCIT_C25150"].
        timeout: Seconds to wait for the lookup service.

    Returns:
        A dict with:
          - labels: {iri: label} for the terms that resolved
          - unresolved: the IRIs that did not resolve
    """
    labels = core.lookup_terms(terms, timeout=timeout)
    asked = [t for t in dict.fromkeys(terms) if t.strip()]
    return {
        "labels": labels,
        "unresolved": [t for t in asked if t not in labels],
    }


@mcp.tool()
def list_elements(
    content: str = "",
    session_id: str = "",
    section: str | None = None,
    datatype: str | None = None,
    missing_field: str | None = None,
) -> dict:
    """List a dictionary's elements as compact summaries, optionally filtered.

    Returns one summary {id, label, datatype, section} per element — enough to
    survey a dictionary without pulling every field. Use get_element for the
    full detail of a specific element.

    Args:
        content: The dictionary (dd-json, LinkML YAML, or CSV, auto-detected).
        section: Only elements in this section. Pass "" for unsectioned ones.
        datatype: Only elements of this datatype (e.g. "integer").
        missing_field: Only elements whose named field is empty — for coverage
            questions like which elements lack a "unit" or "description".
        session_id: An open session from `open_dictionary`, instead of `content`.
            Pass exactly one of `content` or `session_id`.

    Returns:
        {count, elements: [{id, label, datatype, section}, ...]}
    """
    elements = core.list_elements(
        _document(content, session_id),
        section=section,
        datatype=datatype,
        missing_field=missing_field,
    )
    return {"count": len(elements), "elements": elements}


@mcp.tool()
def get_element(
    element_id: str,
    content: str = "",
    session_id: str = "",
) -> dict:
    """Return the full detail of one element by id.

    Args:
        content: The dictionary (dd-json, LinkML YAML, or CSV, auto-detected).
        element_id: The id of the element to fetch.
        session_id: An open session from `open_dictionary`, instead of `content`.
            Pass exactly one of `content` or `session_id`.

    Returns:
        {found: bool, element: <full dd-json element> | null}. If the id is
        duplicated, the first occurrence is returned.
    """
    element = core.get_element(_document(content, session_id), element_id)
    return {"found": element is not None, "element": element}


@mcp.tool()
def describe_dictionary(
    content: str = "", session_id: str = ""
) -> dict:
    """Summarise a dictionary: size, sections, datatypes in use, validity.

    A quick orientation before querying or editing — how big the dictionary is,
    how it is organised, and whether it currently validates.

    Args:
        content: The dictionary (dd-json, LinkML YAML, or CSV, auto-detected).

    Returns:
        {elementCount, sections, datatypes: {name: count}, valid, errorCount,
        warningCount}
    """
    return core.describe_dictionary(_document(content, session_id))


@mcp.tool()
def export(
    to: str = "csv",
    content: str = "",
    session_id: str = "",
    compact: bool = False,
) -> dict:
    """Serialise a dictionary to another format.

    Args:
        content: The dictionary in any supported format (auto-detected).
        to: Target format — "csv", "linkml" (YAML), or "json" (dd-json).
        compact: dd-json only — omit fields that are null or empty. Typically
            about a third the size on a sparse dictionary, and lossless: it
            reloads to the same document, and every tool here accepts it as
            input. Use it when you want to hold a dictionary in context across
            several calls. Leave it false when producing a file to save, since
            the app writes the full form.

    Returns:
        {format, content} where content is the serialised dictionary text.
    """
    return {
        "format": to,
        "content": core.export(
            _document(content, session_id), to, compact=compact
        ),
    }


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
