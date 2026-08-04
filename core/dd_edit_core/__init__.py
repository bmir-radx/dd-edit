"""Shared data-dictionary core over the dd-* toolkit — no FastAPI, no MCP.

The transport-free foundation both the app's sidecar and the MCP server sit on:
format detection, multi-format loading, and validation, factored so the two
consumers agree on how a dictionary parses and validates rather than each
keeping its own copy. See docs/MCP-DESIGN.md.

The duplicate-id and LinkML-emit behaviour is feature-detected against the
pinned toolkit release, so a toolkit bump only has to be reconciled here.
"""

from __future__ import annotations

import inspect
import io
from dataclasses import dataclass
from dataclasses import fields as _dataclass_fields

import yaml
from dd_api import DataDictionary, EmitOptions
from dd_validator.validate import validate as validate_csv

__all__ = [
    "detect",
    "load",
    "Finding",
    "findings_from_csv",
    "validate_document",
    "LINKML_OPTIONS",
    "ALLOW_DUPLICATE_IDS",
    "KEEP_DUPLICATES",
]

# LinkML emit options, feature-detected so LinkML output matches across the app
# and the MCP: newer toolkits sort enum classes last.
LINKML_OPTIONS = (
    EmitOptions(enums_last=True)
    if any(f.name == "enums_last" for f in _dataclass_fields(EmitOptions))
    else EmitOptions()
)

# The editor must hold invalid-but-well-formed documents (duplicate Ids) so a
# user (or an LLM) can see and fix them — the validator flags duplicate-id as an
# ERROR. Feature-detected: ships in toolkit releases after v0.0.4.
KEEP_DUPLICATES = (
    {"keep_duplicates": True}
    if "keep_duplicates" in inspect.signature(DataDictionary.load).parameters
    else {}
)
ALLOW_DUPLICATE_IDS = (
    {"allow_duplicate_ids": True}
    if "allow_duplicate_ids" in inspect.signature(DataDictionary.from_json).parameters
    else {}
)


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


def load(text: str) -> DataDictionary:
    """Parse any supported format into the toolkit's DataDictionary model."""
    kind = detect(text)
    if kind == "json":
        return DataDictionary.from_json(text, **ALLOW_DUPLICATE_IDS)
    if kind == "linkml":
        return DataDictionary.from_linkml(io.StringIO(text))
    return DataDictionary.load(io.StringIO(text), **KEEP_DUPLICATES)


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


def findings_from_csv(csv_text: str) -> list[Finding]:
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
    return findings_from_csv(csv_text)
