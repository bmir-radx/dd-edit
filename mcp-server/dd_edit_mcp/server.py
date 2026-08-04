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

try:
    _VERSION = version("dd-edit-mcp")
except PackageNotFoundError:  # running from a source tree, not installed
    _VERSION = "0.0.0+unknown"

mcp = MCPServer("dd-edit", version=_VERSION)


@mcp.tool()
def validate_dictionary(content: str) -> dict:
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

    Returns:
        A dict with:
          - detected: the format that was detected ("json" | "linkml" | "csv")
          - valid: true if there are no ERROR-level findings
          - findings: list of {level, check, message, line, column, value,
            elementIndex, elementId, suggestion}
    """
    findings = core.validate_document(content)
    return {
        "detected": core.detect(content),
        "valid": not any(f.level == "ERROR" for f in findings),
        "findings": [f.as_dict() for f in findings],
    }


@mcp.tool()
def add_element(
    content: str,
    element: dict,
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
        A dict with:
          - document: the updated dictionary as dd-json text
          - valid: true if there are no ERROR-level findings
          - findings: list of findings (same shape as validate_dictionary)
    """
    result = core.add_element(content, element, index=index, compact=compact)
    return {
        "document": result.document,
        "valid": not any(f.level == "ERROR" for f in result.findings),
        "findings": [f.as_dict() for f in result.findings],
    }


@mcp.tool()
def edit_element(
    content: str,
    element_id: str,
    changes: dict,
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

        Rules the validator enforces, so check the findings: the field ids must
        exist in this dictionary; `<` `<=` `>` `>=` need an ordered (numeric or
        temporal) datatype; `contains` needs cardinality "multiple"; and a value
        compared against an enumerated field should be one of its codes.

        Note the asymmetry: a *malformed* precondition is rejected outright (the
        model cannot hold it), whereas the semantic problems above come back as
        findings on a document that was accepted.

    Returns:
        A dict with:
          - document: the updated dictionary as dd-json text
          - valid: true if there are no ERROR-level findings
          - findings: list of findings (same shape as validate_dictionary)
    """
    result = core.edit_element(content, element_id, changes, compact=compact)
    return {
        "document": result.document,
        "valid": not any(f.level == "ERROR" for f in result.findings),
        "findings": [f.as_dict() for f in result.findings],
    }


@mcp.tool()
def remove_element(
    content: str,
    element_id: str | None = None,
    index: int | None = None,
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

    Returns:
        A dict with:
          - document: the updated dictionary as dd-json text
          - valid: true if there are no ERROR-level findings
          - findings: list of findings (same shape as validate_dictionary)
    """
    result = core.remove_element(content, element_id, index=index, compact=compact)
    return {
        "document": result.document,
        "valid": not any(f.level == "ERROR" for f in result.findings),
        "findings": [f.as_dict() for f in result.findings],
    }


@mcp.tool()
def reorder_elements(
    content: str, order: list[str], compact: bool = False
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

    Returns:
        A dict with:
          - document: the updated dictionary as dd-json text
          - valid: true if there are no ERROR-level findings
          - findings: list of findings (same shape as validate_dictionary)
    """
    result = core.reorder_elements(content, order, compact=compact)
    return {
        "document": result.document,
        "valid": not any(f.level == "ERROR" for f in result.findings),
        "findings": [f.as_dict() for f in result.findings],
    }


@mcp.tool()
def import_redcap(
    content: str,
    provenance: str = "",
    allow_duplicates: bool = False,
    compact: bool = False,
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
        compact=compact,
    )
    return {
        "document": result.document,
        "elementCount": len(core.list_elements(result.document)),
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
    content: str,
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

    Returns:
        {count, elements: [{id, label, datatype, section}, ...]}
    """
    elements = core.list_elements(
        content, section=section, datatype=datatype, missing_field=missing_field
    )
    return {"count": len(elements), "elements": elements}


@mcp.tool()
def get_element(content: str, element_id: str) -> dict:
    """Return the full detail of one element by id.

    Args:
        content: The dictionary (dd-json, LinkML YAML, or CSV, auto-detected).
        element_id: The id of the element to fetch.

    Returns:
        {found: bool, element: <full dd-json element> | null}. If the id is
        duplicated, the first occurrence is returned.
    """
    element = core.get_element(content, element_id)
    return {"found": element is not None, "element": element}


@mcp.tool()
def describe_dictionary(content: str) -> dict:
    """Summarise a dictionary: size, sections, datatypes in use, validity.

    A quick orientation before querying or editing — how big the dictionary is,
    how it is organised, and whether it currently validates.

    Args:
        content: The dictionary (dd-json, LinkML YAML, or CSV, auto-detected).

    Returns:
        {elementCount, sections, datatypes: {name: count}, valid, errorCount,
        warningCount}
    """
    return core.describe_dictionary(content)


@mcp.tool()
def export(content: str, to: str = "csv", compact: bool = False) -> dict:
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
        "content": core.export(content, to, compact=compact),
    }


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
