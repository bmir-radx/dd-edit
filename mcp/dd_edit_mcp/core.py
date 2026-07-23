"""MCP-facing data-dictionary operations: query and author tools.

Phase 1 of docs/MCP-DESIGN.md. The shared, transport-free primitives (detect,
load, validate, Finding) live in dd_edit_core and are re-exported here; this
module adds the query and editing tools on top. Editing tools use the pure
(document, op) -> (document, findings) shape that a phase-2 session will wrap
unchanged.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from dd_api import DataDictionary

# Shared core: both the app's sidecar and this server depend on it, so they
# agree on how a dictionary parses and validates. Re-exported for the server
# module and tests that reference them as core.<name>.
from dd_edit_core import (  # noqa: F401
    ALLOW_DUPLICATE_IDS,
    LINKML_OPTIONS,
    Finding,
    detect,
    findings_from_csv,
    load,
    validate_document,
)


# Fields a caller may set on a new element. Everything else (aliases, terms,
# enumeration, …) the toolkit fills with defaults on load; keeping the accepted
# set explicit means an LLM gets told exactly what it can pass, and a typo like
# "datatypes" is rejected rather than silently dropped into the document.
ELEMENT_FIELDS = frozenset({
    "id", "label", "datatype", "cardinality", "required", "unit",
    "description", "section", "enumeration", "missing_value_codes",
    "pattern", "precondition", "examples", "notes", "provenance",
    "see_also", "aliases", "terms",
})


@dataclass
class EditResult:
    """The outcome of a document-mutating operation.

    The pure phase-1 shape from docs/MCP-DESIGN.md: an operation returns the
    whole new document plus fresh findings, so the caller sees validity
    immediately. In phase 2 the same operation mutates a held document and
    returns only findings — the document field is what a session drops.
    """

    document: str  # dd-json text
    findings: list[Finding]


def add_element(
    document: str,
    element: dict,
    *,
    index: int | None = None,
) -> EditResult:
    """Add a data element to a dictionary and return the new document + findings.

    Pure: the input document is not mutated. The element is inserted, the whole
    document is round-tripped through the toolkit (which normalises it and
    fills defaults), and the result is re-validated. Element order is semantic
    (it is the field order in the target datafile), so `index` controls where
    the element lands; the default appends.

    Args:
        document: the current dictionary as dd-json text.
        element: the new element. `id` is required; `label`, `datatype`, and
            `cardinality` are strongly recommended. Unknown keys are rejected.
        index: 0-based insertion position; None (default) appends at the end.

    Returns:
        EditResult(document=<new dd-json text>, findings=<validation findings>).

    Raises:
        ValueError: the document is malformed, `element` has no `id`, `element`
            carries unknown keys, or `index` is out of range.
    """
    if not isinstance(element, dict):
        raise ValueError("element must be an object")
    if not element.get("id"):
        raise ValueError("element requires a non-empty 'id'")
    unknown = set(element) - ELEMENT_FIELDS
    if unknown:
        raise ValueError(
            f"unknown element field(s): {', '.join(sorted(unknown))}; "
            f"allowed: {', '.join(sorted(ELEMENT_FIELDS))}"
        )

    # Normalise the input to dd-json (accepts CSV/LinkML too) as a plain dict.
    doc = json.loads(load(document).to_json())
    elements = doc.get("elements", [])

    pos = len(elements) if index is None else index
    if not 0 <= pos <= len(elements):
        raise ValueError(
            f"index {index} out of range for {len(elements)} element(s)"
        )
    elements.insert(pos, dict(element))
    doc["elements"] = elements

    # Round-trip: the toolkit normalises the inserted element and fills
    # defaults. allow_duplicate_ids so a clashing id becomes a finding, not a
    # hard error — the caller should see and fix it, matching the app.
    dd = DataDictionary.from_json(json.dumps(doc), **ALLOW_DUPLICATE_IDS)
    new_text = dd.to_json()
    return EditResult(document=new_text, findings=findings_from_csv(dd.to_csv()))


# ------------------------------------------------------------------ queries
#
# Read-only tools. They work off the dd-json dict (load(...).to_json()) rather
# than the DataElement object model, for the same reason add_element does: the
# dd-json shape is canonical, stable, and exactly what a caller should see.


def _elements(document: str) -> list[dict]:
    return json.loads(load(document).to_json()).get("elements", [])


def list_elements(
    document: str,
    *,
    section: str | None = None,
    datatype: str | None = None,
    missing_field: str | None = None,
) -> list[dict]:
    """List elements as compact summaries, optionally filtered.

    Each summary is {id, label, datatype, section} — enough to survey a
    dictionary without pulling every field. Use get_element for full detail.

    Filters (combined with AND):
        section: only elements in this section (use "" for the unsectioned ones).
        datatype: only elements of this datatype.
        missing_field: only elements whose named field is null/empty — for
            coverage checks like "which elements lack a unit".
    """
    out = []
    for e in _elements(document):
        if section is not None and (e.get("section") or "") != section:
            continue
        if datatype is not None and e.get("datatype") != datatype:
            continue
        if missing_field is not None:
            v = e.get(missing_field)
            if v not in (None, "", [], {}):
                continue
        out.append({
            "id": e.get("id"),
            "label": e.get("label"),
            "datatype": e.get("datatype"),
            "section": e.get("section"),
        })
    return out


def get_element(document: str, element_id: str) -> dict | None:
    """Return the full dd-json for one element by id, or None if not found.

    If the id is duplicated in the document, the first occurrence is returned.
    """
    for e in _elements(document):
        if e.get("id") == element_id:
            return e
    return None


def describe_dictionary(document: str) -> dict:
    """Summarise a dictionary: counts, sections, datatypes in use, validity.

    A quick orientation for an LLM before it queries or edits — how big the
    dictionary is, how it is organised, and whether it currently validates.
    """
    elements = _elements(document)
    sections: list[str] = []
    datatypes: dict[str, int] = {}
    for e in elements:
        sec = e.get("section")
        if sec and sec not in sections:
            sections.append(sec)
        dt = e.get("datatype")
        if dt:
            datatypes[dt] = datatypes.get(dt, 0) + 1
    findings = findings_from_csv(load(document).to_csv())
    return {
        "elementCount": len(elements),
        "sections": sections,
        "datatypes": datatypes,
        "valid": not any(f.level == "ERROR" for f in findings),
        "errorCount": sum(1 for f in findings if f.level == "ERROR"),
        "warningCount": sum(1 for f in findings if f.level == "WARNING"),
    }


def export(document: str, to: str = "csv") -> str:
    """Serialise a dictionary to another format.

    Args:
        document: the dictionary in any supported format (auto-detected).
        to: target format — "csv", "linkml" (YAML), or "json" (dd-json).

    Raises:
        ValueError: unknown target format, or malformed input.
    """
    dd = load(document)
    if to == "csv":
        return dd.to_csv()
    if to == "linkml":
        return dd.to_linkml(LINKML_OPTIONS)
    if to == "json":
        return dd.to_json()
    raise ValueError(f"unknown format {to!r}; expected csv, linkml, or json")
