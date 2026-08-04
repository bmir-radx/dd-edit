"""MCP-facing data-dictionary operations: query and author tools.

Phase 1 of docs/MCP-DESIGN.md. The shared, transport-free primitives (detect,
load, validate, Finding) live in dd_edit_core and are re-exported here; this
module adds the query and editing tools on top. Editing tools use the pure
(document, op) -> (document, findings) shape that a phase-2 session will wrap
unchanged.
"""

from __future__ import annotations

import json
import re
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


def _apply(doc: dict, what: str) -> EditResult:
    """Round-trip an edited dd-json dict through the toolkit; re-validate.

    The tail shared by every editing tool. The toolkit normalises the document
    and fills defaults, and allow_duplicate_ids lets a clashing id come back as a
    finding rather than a hard error — the caller should see and fix it, matching
    the app.

    Some bad values the model refuses to hold at all, though: an unknown
    datatype, or a malformed enumeration or precondition, makes from_json raise
    ReadError (a ValueError) addressed to a line of the CSV round-trip the caller
    never saw. Re-raise those as `<what>: <reason>` so the message names the edit
    the caller actually made. Values the model *can* hold stay findings.
    """
    try:
        dd = DataDictionary.from_json(json.dumps(doc), **ALLOW_DUPLICATE_IDS)
    except ValueError as exc:
        # Drop the toolkit's "Line N:" prefix: N indexes the internal CSV
        # serialization, so quoting it at the caller is worse than saying nothing.
        reason = re.sub(r"^Line \d+:\s*", "", str(exc))
        raise ValueError(f"{what}: {reason}") from exc
    return EditResult(document=dd.to_json(), findings=findings_from_csv(dd.to_csv()))


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
            carries unknown keys, `index` is out of range, or `element` carries a
            value the model cannot hold at all (an unknown datatype, a malformed
            enumeration or precondition). Note the asymmetry: a duplicate id is a
            *finding*, because the model can hold it; an unknown datatype is a
            raise, because from_json rejects it outright.
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

    return _apply(doc, f"cannot add element {element['id']!r}")


def edit_element(
    document: str,
    element_id: str,
    changes: dict,
) -> EditResult:
    """Change fields on one element and return the new document + findings.

    Pure: the input document is not mutated. Only the named fields change; every
    other field of the element, and every other element, is left alone.

    Patch semantics follow the app's editing model, so an LLM edit and a human
    edit mean the same thing: an omitted key leaves that field untouched, and an
    explicit `null` clears it. (The app stores cleared optional scalars as null,
    never "" or a missing key.) Clear a list-valued field with `[]`.

    `id` may be changed — that is a rename. Nothing else in the document is
    rewritten to follow it, so a rename can orphan a reference (e.g. a
    precondition naming the old id); the returned findings are how the caller
    sees that.

    Args:
        document: the current dictionary as dd-json text.
        element_id: the id of the element to change. If the id is duplicated,
            the first occurrence is edited.
        changes: the fields to change. Unknown keys are rejected. Pass null to
            clear an optional field; omit a key to leave it as it is.

    Returns:
        EditResult(document=<new dd-json text>, findings=<validation findings>).

    Raises:
        ValueError: the document is malformed, no element has `element_id`,
            `changes` carries unknown keys, is not an object, is empty, would
            blank out a mandatory field (`id`, `label`, `datatype`), or carries a
            value the model cannot hold at all (an unknown datatype, a malformed
            enumeration or precondition). Note the asymmetry: a duplicate id is a
            *finding*, because the model can hold it; an unknown datatype is a
            raise, because from_json rejects it outright.
    """
    if not isinstance(changes, dict):
        raise ValueError("changes must be an object")
    if not changes:
        raise ValueError("changes is empty: nothing to do")
    unknown = set(changes) - ELEMENT_FIELDS
    if unknown:
        raise ValueError(
            f"unknown element field(s): {', '.join(sorted(unknown))}; "
            f"allowed: {', '.join(sorted(ELEMENT_FIELDS))}"
        )
    # id/label/datatype are non-optional in dd-json, so null/"" is never a
    # meaningful "clear" for them — reject rather than write a broken element.
    for field in ("id", "label", "datatype"):
        if field in changes and not changes[field]:
            raise ValueError(f"{field} cannot be cleared: it is required")

    doc = json.loads(load(document).to_json())
    elements = doc.get("elements", [])

    target = next(
        (i for i, e in enumerate(elements) if e.get("id") == element_id), None
    )
    if target is None:
        raise ValueError(f"no element with id {element_id!r}")

    # Merge over a copy: unnamed fields survive untouched, null clears.
    elements[target] = {**elements[target], **changes}
    doc["elements"] = elements

    offending = ", ".join(f"{k}={changes[k]!r}" for k in sorted(changes))
    return _apply(
        doc, f"cannot apply {{{offending}}} to element {element_id!r}"
    )


def remove_element(
    document: str,
    element_id: str | None = None,
    *,
    index: int | None = None,
) -> EditResult:
    """Delete one element and return the new document + findings.

    Pure: the input document is not mutated. Exactly one element is removed; the
    order of the rest is preserved (order is semantic — it is the field order in
    the target datafile).

    Address the element by `element_id`, by `index`, or both (both = "the element
    at this index, which must have this id" — a safety belt worth using if the
    caller is working from a stale listing).

    A dictionary can hold duplicate ids (the validator flags it, the model
    tolerates it), which makes an id ambiguous. Unlike `get_element` and
    `edit_element`, which act on the first match, removal *refuses* rather than
    guessing: a wrong edit is visible in the returned document, but a wrong
    delete just silently leaves fewer elements, and a stateless tool has no undo.
    Pass `index` to disambiguate.

    Removing an element other elements refer to (e.g. in a `precondition`) leaves
    that reference dangling; the validator reports it as an
    `unknown-precondition-field` ERROR in the returned findings. Removing the
    last element is allowed and yields a valid empty dictionary.

    Args:
        document: the current dictionary as dd-json text.
        element_id: the id of the element to remove.
        index: 0-based position of the element to remove.

    Returns:
        EditResult(document=<new dd-json text>, findings=<validation findings>).

    Raises:
        ValueError: the document is malformed, neither `element_id` nor `index`
            was given, `index` is out of range, no element matches, or
            `element_id` is ambiguous (several elements share it) — the message
            lists the matching positions so the caller can retry with `index`.
    """
    if element_id is None and index is None:
        raise ValueError("pass element_id, index, or both: nothing identified")

    doc = json.loads(load(document).to_json())
    elements = doc.get("elements", [])

    if index is not None and not 0 <= index < len(elements):
        raise ValueError(
            f"index {index} out of range for {len(elements)} element(s)"
        )

    if element_id is None:
        target = index
    else:
        matches = [i for i, e in enumerate(elements) if e.get("id") == element_id]
        if not matches:
            raise ValueError(f"no element with id {element_id!r}")
        if index is None:
            if len(matches) > 1:
                positions = ", ".join(str(i) for i in matches)
                raise ValueError(
                    f"{len(matches)} elements have id {element_id!r} "
                    f"(positions {positions}); pass index to choose one"
                )
            target = matches[0]
        else:
            # Both given: the index wins, but only if it really is that element.
            if index not in matches:
                actual = elements[index].get("id")
                raise ValueError(
                    f"element at index {index} has id {actual!r}, "
                    f"not {element_id!r}"
                )
            target = index

    removed = elements.pop(target)
    doc["elements"] = elements

    return _apply(doc, f"cannot remove element {removed.get('id')!r}")


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
