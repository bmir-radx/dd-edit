"""MCP-facing data-dictionary operations: query and author tools.

Phase 1 of docs/MCP-DESIGN.md. The shared, transport-free primitives (detect,
load, validate, Finding) live in dd_edit_core and are re-exported here; this
module adds the query and editing tools on top. Editing tools use the pure
(document, op) -> (document, findings) shape that a phase-2 session will wrap
unchanged.
"""

from __future__ import annotations

import hashlib
import io
import json
import re
from dataclasses import dataclass
from pathlib import Path

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


def _apply(doc: dict, what: str, *, compact: bool = False) -> EditResult:
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

    `compact` omits null/empty fields from the returned document. Validation is
    unaffected — findings come from the CSV serialisation either way — so this
    only changes how much text the caller carries between calls.
    """
    try:
        dd = DataDictionary.from_json(json.dumps(doc), **ALLOW_DUPLICATE_IDS)
    except ValueError as exc:
        # Drop the toolkit's "Line N:" prefix: N indexes the internal CSV
        # serialization, so quoting it at the caller is worse than saying nothing.
        reason = re.sub(r"^Line \d+:\s*", "", str(exc))
        raise ValueError(f"{what}: {reason}") from exc
    return EditResult(
        document=dd.to_json(compact=compact),
        findings=findings_from_csv(dd.to_csv()),
    )


def add_element(
    document: str,
    element: dict,
    *,
    index: int | None = None,
    compact: bool = False,
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
        compact: return the document with null/empty fields omitted — about
            half the size on a typical dictionary, and accepted as input by every
            tool here. Lossless: it reloads to the same document.

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

    return _apply(doc, f"cannot add element {element['id']!r}", compact=compact)


def edit_element(
    document: str,
    element_id: str,
    changes: dict,
    *,
    compact: bool = False,
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
        compact: return the document with null/empty fields omitted — about
            half the size on a typical dictionary, and accepted as input by every
            tool here. Lossless: it reloads to the same document.

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
        doc, f"cannot apply {{{offending}}} to element {element_id!r}",
        compact=compact,
    )


def remove_element(
    document: str,
    element_id: str | None = None,
    *,
    index: int | None = None,
    compact: bool = False,
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
        compact: return the document with null/empty fields omitted — about
            half the size on a typical dictionary, and accepted as input by every
            tool here. Lossless: it reloads to the same document.

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

    return _apply(doc, f"cannot remove element {removed.get('id')!r}", compact=compact)


def reorder_elements(
    document: str, order: list[str], *, compact: bool = False
) -> EditResult:
    """Reorder a dictionary's elements and return the new document + findings.

    Pure: the input document is not mutated. Nothing about any element changes —
    only their sequence. Element order is semantic (it is the column order in the
    target datafile, see DESIGN.md), so this is a real edit to what the dictionary
    describes, not presentation.

    `order` is declarative: it lists *every* id in the wanted order, and must be
    an exact permutation of the ids already present. A list that omits, repeats,
    or invents an id is refused with a message naming the discrepancy. That is the
    point of the whole-list shape — a truncated or half-hallucinated list would
    otherwise silently drop elements, and unlike a bad edit, a scrambled column
    order is not visible in the content of the result.

    Reordering by id requires ids to be unique. A dictionary can hold duplicates
    (the validator flags them, the model tolerates them), but then an id no longer
    identifies one element, so this refuses — as `remove_element` does. Fix the
    duplicates first.

    Args:
        document: the current dictionary as dd-json text.
        order: every element id, in the desired order.
        compact: return the document with null/empty fields omitted — about
            half the size on a typical dictionary, and accepted as input by every
            tool here. Lossless: it reloads to the same document.

    Returns:
        EditResult(document=<new dd-json text>, findings=<validation findings>).

    Raises:
        ValueError: the document is malformed, `order` is not a list of strings,
            the document's ids are not unique, or `order` is not an exact
            permutation of them (the message names what is missing, repeated, or
            unknown).
    """
    if not isinstance(order, list) or not all(isinstance(i, str) for i in order):
        raise ValueError("order must be a list of element ids")

    doc = json.loads(load(document).to_json())
    elements = doc.get("elements", [])
    ids = [e.get("id") for e in elements]

    # Reordering by id is only meaningful if ids identify elements.
    duplicated = sorted({i for i in ids if ids.count(i) > 1})
    if duplicated:
        raise ValueError(
            f"cannot reorder by id: {', '.join(repr(i) for i in duplicated)} "
            f"appears more than once; ids must be unique to reorder by id"
        )

    # Report every way the list fails to be a permutation, not just the first.
    problems = []
    unknown = [i for i in order if i not in ids]
    if unknown:
        problems.append(f"not in the document: {', '.join(map(repr, unknown))}")
    repeated = sorted({i for i in order if order.count(i) > 1})
    if repeated:
        problems.append(f"listed twice: {', '.join(map(repr, repeated))}")
    missing = [i for i in ids if i not in order]
    if missing:
        problems.append(f"omitted: {', '.join(map(repr, missing))}")
    if problems:
        raise ValueError(
            f"order must list all {len(ids)} element id(s) exactly once — "
            + "; ".join(problems)
        )

    by_id = {e.get("id"): e for e in elements}
    doc["elements"] = [by_id[i] for i in order]

    return _apply(doc, "cannot reorder elements", compact=compact)


def import_redcap(
    content: str,
    *,
    provenance: str = "",
    allow_duplicates: bool = False,
    compact: bool = False,
) -> EditResult:
    """Convert a REDCap data-dictionary export into a dd-json document.

    This is the one tool that *creates* a document rather than editing one, so
    there is no input document — `content` is the REDCap CSV. The result is
    returned with findings, like every editing tool, because a converted
    dictionary usually needs work (REDCap carries no units, for instance) and the
    findings are the to-do list.

    REDCap's branching logic is **not** translated into a `precondition`: the two
    grammars differ, so it is dropped rather than guessed at. Re-add any that
    matter with `edit_element`.

    Args:
        content: the REDCap data-dictionary export, as CSV text.
        provenance: fills every element's `provenance` field — typically the
            study or instrument name. Recommended: it is the only record of where
            these elements came from.
        allow_duplicates: REDCap multi-form exports commonly repeat a shared field
            on every form. False (default) rejects a repeated variable name; True
            keeps the *first* occurrence and silently drops the rest, so compare
            `elementCount` against what you expected.
        compact: return the document with null/empty fields omitted — about
            half the size on a typical dictionary, and accepted as input by every
            tool here. Lossless: it reloads to the same document.

    Returns:
        EditResult(document=<new dd-json text>, findings=<validation findings>).

    Raises:
        ValueError: the input is not a REDCap dictionary (no
            'Variable / Field Name' column), or a variable name repeats and
            `allow_duplicates` is False. dd_redcap's ConversionError is a
            ValueError, so both arrive as one type.
    """
    # Imported here, not at module load: this is the only tool that needs the
    # REDCap converter, and keeping it lazy means the other eight still work if
    # the optional dependency is missing from an install.
    from dd_redcap.convert import convert_redcap

    try:
        dd = convert_redcap(
            io.StringIO(content),
            provenance=provenance,
            allow_duplicates=allow_duplicates,
        )
    except ValueError as exc:  # includes dd_redcap.ConversionError
        raise ValueError(f"cannot convert REDCap dictionary: {exc}") from exc

    # Round-trip through _apply for the same normalise-and-validate tail every
    # editing tool uses, so an imported document is validated identically.
    return _apply(
        json.loads(dd.to_json()),
        "cannot convert REDCap dictionary",
        compact=compact,
    )


# Cap on one lookup_terms call, matching the sidecar's /terms endpoint: one
# request should not fan out into hundreds of upstream ontology lookups.
MAX_TERMS_PER_LOOKUP = 100


def lookup_terms(terms: list[str], *, timeout: float = 15.0) -> dict[str, str]:
    """Resolve ontology term IRIs to human-readable labels.

    The one operation here that leaves the process: it queries OLS4 over the
    network. Everything else is pure and offline.

    Unresolved terms are simply absent from the result rather than being an
    error — a term may be private, retired, or mistyped, and the caller can tell
    which by comparing the keys against what it asked for. Only a transport-level
    failure raises.

    Input is de-duplicated (preserving order) and capped at
    MAX_TERMS_PER_LOOKUP, matching the sidecar, so one call cannot fan out into
    hundreds of upstream lookups.

    Args:
        terms: term IRIs to resolve. Blanks are ignored.
        timeout: seconds to wait on the upstream service.

    Returns:
        {iri: label} for the terms that resolved. Absent keys did not resolve.

    Raises:
        ValueError: `terms` is not a list of strings, or the lookup service could
            not be reached at all.
    """
    if not isinstance(terms, list) or not all(isinstance(t, str) for t in terms):
        raise ValueError("terms must be a list of term IRIs")

    from dd_core.terms_lookup import lookup_labels

    # dict.fromkeys de-duplicates while keeping first-seen order.
    requested = [t for t in dict.fromkeys(terms) if t.strip()]
    if not requested:
        return {}

    try:
        return lookup_labels(requested[:MAX_TERMS_PER_LOOKUP], timeout=timeout)
    except Exception as exc:  # network/transport failure, not the caller's fault
        raise ValueError(f"term lookup failed: {exc}") from exc


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


def export(document: str, to: str = "csv", *, compact: bool = False) -> str:
    """Serialise a dictionary to another format.

    Args:
        document: the dictionary in any supported format (auto-detected).
        to: target format — "csv", "linkml" (YAML), or "json" (dd-json).
        compact: dd-json only — omit fields that are null or empty. The result
            reloads to an identical document (the omitted fields are exactly the
            ones `load` fills back in), so this is lossless, but it is a wire
            convenience rather than a storage format: the app always writes the
            full form. Ignored for csv/linkml.

    Raises:
        ValueError: unknown target format, or malformed input.
    """
    dd = load(document)
    if to == "csv":
        return dd.to_csv()
    if to == "linkml":
        return dd.to_linkml(LINKML_OPTIONS)
    if to == "json":
        return dd.to_json(compact=compact)
    raise ValueError(f"unknown format {to!r}; expected csv, linkml, or json")


# --- Saving to disk ------------------------------------------------------------
#
# The one place this server touches the filesystem. Every other operation is
# text in, text out — which is why they are safe to expose to anyone. Writing
# files is different in kind, so the boundary is drawn explicitly here rather
# than left to each caller: a save is confined to a root directory the operator
# chose at startup, and refuses to clobber a file that changed underneath it.

FORMAT_SUFFIXES = {
    "csv": (".csv",),
    "linkml": (".yaml", ".yml"),
    "json": (".json",),
}


def format_for_path(path: Path, to: str = "") -> str:
    """Pick the serialisation format for a save, from `to` or the suffix.

    Inferring from the extension is what makes `save_dictionary(path=...)` a
    one-argument call in the common case; an explicit `to` still wins, for the
    caller who wants LinkML in a file named `.txt`.

    Raises:
        ValueError: `to` is not a known format, or it was omitted and the
            suffix does not identify one.
    """
    if to:
        if to not in FORMAT_SUFFIXES:
            raise ValueError(
                f"unknown format {to!r}; expected csv, linkml, or json"
            )
        return to
    suffix = path.suffix.lower()
    for name, suffixes in FORMAT_SUFFIXES.items():
        if suffix in suffixes:
            return name
    raise ValueError(
        f"cannot infer a format from {path.name!r} — pass to= explicitly "
        f"(csv, linkml, or json), or use a .csv/.yaml/.json extension"
    )


def resolve_save_path(path: str, root: Path | None) -> Path:
    """Resolve a caller-supplied path, refusing to escape the save root.

    `root` is the directory the operator passed at startup; None means saving is
    disabled, which is the default. The check is done on the *resolved* path so
    that `..` segments and symlinks cannot walk out of the root — comparing the
    strings a caller sent would miss both.

    Raises:
        ValueError: saving is not configured, or the path lands outside root.
    """
    if root is None:
        raise ValueError(
            "saving is not enabled on this server — start it with "
            "--save-root DIR to allow save_dictionary, or use export and "
            "write the file yourself"
        )
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve()
    root_resolved = root.resolve()
    if resolved != root_resolved and root_resolved not in resolved.parents:
        raise ValueError(
            f"refusing to save outside the save root: {path!r} resolves to "
            f"{resolved}, which is not under {root_resolved}"
        )
    if resolved.is_dir():
        raise ValueError(f"{resolved} is a directory, not a file")
    return resolved


def save_document(
    document: str,
    path: str,
    *,
    root: Path | None,
    to: str = "",
    expect_sha256: str = "",
    overwrite: bool = True,
) -> dict:
    """Serialise a dictionary and write it, returning a summary — not the text.

    The point of this tool is that the document never crosses the wire. `export`
    hands the caller a whole dictionary so it can write the file itself, which
    costs the caller the document twice (once out, once back); this writes it
    server-side and returns only what was written.

    `expect_sha256` is the concurrency guard: pass the digest the caller believes
    is on disk and the write is refused if the file has changed since. That is
    the case that actually bites — a human editing the same file in dd-edit
    while an LLM edits a session — and it is cheap to check.

    Returns:
        {path, format, bytesWritten, sha256, existed, valid, elementCount}
    """
    resolved = resolve_save_path(path, root)
    fmt = format_for_path(resolved, to)

    existed = resolved.exists()
    if existed:
        previous = resolved.read_bytes()
        previous_digest = hashlib.sha256(previous).hexdigest()
        if expect_sha256 and previous_digest != expect_sha256:
            raise ValueError(
                f"{resolved} changed on disk since it was read (expected "
                f"sha256 {expect_sha256[:12]}…, found {previous_digest[:12]}…) "
                f"— re-read it and merge before saving over it"
            )
        if not overwrite:
            raise ValueError(
                f"{resolved} exists and overwrite is false; pass "
                f"overwrite=true to replace it"
            )
    elif expect_sha256:
        raise ValueError(
            f"{resolved} does not exist, but expect_sha256 was given — pass it "
            f"only when saving over a file you have already read"
        )

    text = export(document, fmt)
    # newline="" so the CSV writer's \r\n line endings reach the file intact:
    # Python would otherwise translate them on write.
    with open(resolved, "w", newline="", encoding="utf-8") as handle:
        handle.write(text)

    written = resolved.read_bytes()
    described = describe_dictionary(document)
    return {
        "path": str(resolved),
        "format": fmt,
        "bytesWritten": len(written),
        "sha256": hashlib.sha256(written).hexdigest(),
        "existed": existed,
        "valid": described["valid"],
        "elementCount": described["elementCount"],
    }
