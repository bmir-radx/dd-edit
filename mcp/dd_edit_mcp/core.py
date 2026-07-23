"""Pure data-dictionary operations over the dd-* toolkit — no FastAPI, no MCP.

This is the phase-1 "stateless core" from docs/MCP-DESIGN.md: the domain logic
lives here as plain functions, so both an MCP server and (today) the app's
sidecar could sit on top of it. The validation pipeline is ported verbatim from
sidecar/dd_edit_sidecar/app.py to stay behaviour-compatible with the app.
"""

from __future__ import annotations

import inspect
import io
import json
from dataclasses import dataclass

import yaml
from dd_api import DataDictionary
from dd_validator.validate import validate as validate_csv


def detect(text: str) -> str:
    """Guess the input format: 'json' (dd-json), 'linkml', or 'csv'.

    Mirrors the dd-json CLI's detection so the app, CLI, and MCP agree.
    """
    if text.lstrip().startswith("{"):
        return "json"
    try:
        data = yaml.safe_load(text)
        if isinstance(data, dict) and "classes" in data:
            return "linkml"
    except yaml.YAMLError:
        pass
    return "csv"


# The editor must hold invalid-but-well-formed documents (duplicate Ids) so a
# user (or an LLM) can see and fix them — the validator flags duplicate-id as an
# ERROR. Feature-detected: ships in toolkit releases after v0.0.4.
_KEEP_DUPLICATES = (
    {"keep_duplicates": True}
    if "keep_duplicates" in inspect.signature(DataDictionary.load).parameters
    else {}
)
_ALLOW_DUPLICATE_IDS = (
    {"allow_duplicate_ids": True}
    if "allow_duplicate_ids" in inspect.signature(DataDictionary.from_json).parameters
    else {}
)


def load(text: str) -> DataDictionary:
    """Parse any supported format into the toolkit's DataDictionary model."""
    kind = detect(text)
    if kind == "json":
        return DataDictionary.from_json(text, **_ALLOW_DUPLICATE_IDS)
    if kind == "linkml":
        return DataDictionary.from_linkml(io.StringIO(text))
    return DataDictionary.load(io.StringIO(text), **_KEEP_DUPLICATES)


@dataclass
class Finding:
    """A single validation finding, format-independent where possible."""

    level: str
    check: str
    message: str
    line: int | None = None
    column: int | None = None
    value: str | None = None
    element_index: int | None = None
    element_id: str | None = None
    suggestion: str | None = None

    def as_dict(self) -> dict:
        return {
            "level": self.level,
            "check": self.check,
            "message": self.message,
            "line": self.line,
            "column": self.column,
            "value": self.value,
            "elementIndex": self.element_index,
            "elementId": self.element_id,
            "suggestion": self.suggestion,
        }


def _findings_from_csv(csv_text: str) -> list[Finding]:
    """Run the validator over a CSV serialization and adapt its findings.

    The validator carries a format-independent address (elementIndex =
    document-order position = grid row) since toolkit v0.0.6; line numbers
    remain for the CSV view. getattr keeps an older toolkit from crashing.
    """
    return [
        Finding(
            level=f.level.name,
            check=f.check,
            message=f.message,
            line=f.line,
            column=f.column,
            value=f.value,
            element_index=getattr(f, "element_index", None),
            element_id=getattr(f, "element_id", None),
            suggestion=getattr(f, "suggestion", None),
        )
        for f in validate_csv(io.StringIO(csv_text))
    ]


def validate_document(content: str) -> list[Finding]:
    """Validate a data dictionary in any supported format.

    The validator works on the CSV serialization; other formats are converted
    first. Raises ValueError on malformed input the parser can't load at all
    (as opposed to well-formed-but-invalid, which returns findings).
    """
    kind = detect(content)
    csv_text = content if kind == "csv" else load(content).to_csv()
    return _findings_from_csv(csv_text)


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
    dd = DataDictionary.from_json(json.dumps(doc), **_ALLOW_DUPLICATE_IDS)
    new_text = dd.to_json()
    return EditResult(document=new_text, findings=_findings_from_csv(dd.to_csv()))
