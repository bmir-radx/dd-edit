"""Pure data-dictionary operations over the dd-* toolkit — no FastAPI, no MCP.

This is the phase-1 "stateless core" from docs/MCP-DESIGN.md: the domain logic
lives here as plain functions, so both an MCP server and (today) the app's
sidecar could sit on top of it. The validation pipeline is ported verbatim from
sidecar/dd_edit_sidecar/app.py to stay behaviour-compatible with the app.
"""

from __future__ import annotations

import inspect
import io
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


def validate_document(content: str) -> list[Finding]:
    """Validate a data dictionary in any supported format.

    The validator works on the CSV serialization; other formats are converted
    first. Raises ValueError on malformed input the parser can't load at all
    (as opposed to well-formed-but-invalid, which returns findings).
    """
    kind = detect(content)
    csv_text = content if kind == "csv" else load(content).to_csv()
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
