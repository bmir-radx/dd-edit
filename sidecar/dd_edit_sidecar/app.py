"""The dd-edit sidecar: a stateless HTTP wrapper around the dd toolkit.

Every endpoint is a pure function — dd-json (or CSV / LinkML text) in,
converted text / findings / HTML out. The Electron app owns all document
state; nothing is kept here between requests.

Requests must carry ``Authorization: Bearer <token>`` matching the
``DD_EDIT_TOKEN`` environment variable when it is set (the Electron main
process always sets it; unset means an unauthenticated dev run). ``/health``
is exempt so liveness can be probed without credentials.
"""

from __future__ import annotations

import inspect
import io
import os
from dataclasses import fields as dataclass_fields
from importlib.metadata import PackageNotFoundError, version
from typing import Literal, Optional

import yaml
from dd_api import DataDictionary, EmitOptions
from dd_core import ORDERED_DATATYPES

try:  # the full datatype vocabulary (builtin-mapped + custom); post-v0.0.4 layout
    from dd_core.datatypes import BUILTIN_RANGES, CUSTOM_TYPES

    _DATATYPE_NAMES: list[str] = sorted(set(BUILTIN_RANGES) | set(CUSTOM_TYPES))
except ImportError:  # pragma: no cover - older pinned toolkit
    _DATATYPE_NAMES = sorted(ORDERED_DATATYPES)

# LinkML-native names lead the /meta list (the editor shows them first).
_LINKML_NATIVE = [
    "string", "integer", "decimal", "float", "double", "boolean",
    "date", "dateTime", "time", "anyURI",
]
_DATATYPES_ORDERED = [n for n in _LINKML_NATIVE if n in _DATATYPE_NAMES] + [
    n for n in _DATATYPE_NAMES if n not in _LINKML_NATIVE
]
from dd_printer.load import load_dictionary
from dd_printer.render_html import render_html
from dd_redcap.convert import convert_redcap
from dd_redcap.headers import ConversionError
from dd_validator.validate import validate as validate_csv
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI(title="dd-edit sidecar", docs_url=None, redoc_url=None)

# Emit the enums section (and so the boilerplate StandardMissingValueCodes)
# after classes in LinkML previews, so a small dictionary's rendering leads
# with its data elements. Feature-detected: the option ships in toolkit
# releases newer than v0.0.4, and this activates automatically on a pin bump.
_LINKML_OPTIONS = (
    EmitOptions(enums_last=True)
    if any(f.name == "enums_last" for f in dataclass_fields(EmitOptions))
    else None
)

_TOOLKIT_PACKAGES = ("dd-core", "dd-linkml", "dd-api", "dd-validate", "dd-printer", "dd-redcap")


@app.middleware("http")
async def _require_token(request: Request, call_next):
    # OPTIONS preflights carry no Authorization header by design; they are
    # answered by the CORS middleware and expose nothing.
    token = os.environ.get("DD_EDIT_TOKEN")
    if token and request.method != "OPTIONS" and request.url.path != "/health":
        supplied = request.headers.get("authorization", "")
        if supplied != f"Bearer {token}":
            return JSONResponse({"detail": "missing or bad token"}, status_code=401)
    return await call_next(request)


# The Electron renderer is a different origin (the Vite dev server in dev,
# file:// in production), so without CORS headers Chromium blocks every fetch.
# Any-origin is fine HERE because CORS is not this service's security boundary:
# it binds to 127.0.0.1 only and every data-bearing endpoint requires the
# bearer token, which browsers never attach on their own.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["authorization", "content-type"],
)


def _versions() -> dict[str, str]:
    out = {}
    for name in _TOOLKIT_PACKAGES:
        try:
            out[name] = version(name)
        except PackageNotFoundError:  # pragma: no cover - partial installs only
            out[name] = "missing"
    return out


def _detect(text: str) -> str:
    """Guess the input format: 'json' (dd-json), 'linkml', or 'csv'.

    Mirrors the dd-json CLI's detection so the app and CLI agree.
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


# The editor must hold invalid-but-well-formed documents (duplicate Ids) so
# the user can see and fix them — the validator flags duplicate-id as an
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


def _load(text: str) -> DataDictionary:
    kind = _detect(text)
    if kind == "json":
        return DataDictionary.from_json(text, **_ALLOW_DUPLICATE_IDS)
    if kind == "linkml":
        return DataDictionary.from_linkml(io.StringIO(text))
    return DataDictionary.load(io.StringIO(text), **_KEEP_DUPLICATES)


class ConvertRequest(BaseModel):
    content: str
    to: Literal["csv", "linkml", "json"] = "json"
    compact: bool = False


class ValidateRequest(BaseModel):
    content: str


class RenderRequest(BaseModel):
    content: str
    title: Optional[str] = None


class TermsRequest(BaseModel):
    terms: list[str]


class RedcapImportRequest(BaseModel):
    content: str
    provenance: str = ""
    allow_duplicates: bool = True  # multi-form exports repeat shared fields


@app.get("/health")
def health():
    return {"status": "ok", "versions": _versions()}


@app.get("/meta")
def meta():
    return {
        "datatypes": _DATATYPES_ORDERED,
        "cardinalities": ["single", "multiple"],
        "versions": _versions(),
    }


@app.post("/convert")
def convert(req: ConvertRequest):
    try:
        dd = _load(req.content)
        if req.to == "csv":
            content = dd.to_csv()
        elif req.to == "linkml":
            content = dd.to_linkml(_LINKML_OPTIONS)
        else:
            content = dd.to_json(compact=req.compact)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"content": content, "detected": _detect(req.content)}


@app.post("/terms")
def terms(req: TermsRequest):
    """Resolve ontology term identifiers to human-readable labels (via OLS4).

    Needs network access; unresolved terms are simply absent from the result,
    so the app can cache both hits and misses. Capped to keep one request from
    fanning out into hundreds of upstream lookups.
    """
    from dd_core.terms_lookup import lookup_labels

    requested = [t for t in dict.fromkeys(req.terms) if t.strip()][:100]
    try:
        labels = lookup_labels(requested)
    except Exception as exc:  # lookup errors are not the caller's fault
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return {"labels": labels}


@app.post("/validate")
def validate(req: ValidateRequest):
    # The validator works on the CSV serialization; other formats are
    # converted first. Findings carry the format-independent address
    # (elementIndex = document-order position = grid row) since toolkit
    # v0.0.6; line numbers remain for the CSV view. getattr keeps a dev
    # override on an older toolkit from crashing the endpoint.
    kind = _detect(req.content)
    try:
        csv_text = req.content if kind == "csv" else _load(req.content).to_csv()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    findings = validate_csv(io.StringIO(csv_text))
    return {
        "findings": [
            {
                "level": f.level.name,
                "check": f.check,
                "message": f.message,
                "line": f.line,
                "column": f.column,
                "value": f.value,
                "elementIndex": getattr(f, "element_index", None),
                "elementId": getattr(f, "element_id", None),
                "suggestion": getattr(f, "suggestion", None),
            }
            for f in findings
        ]
    }


@app.post("/render")
def render(req: RenderRequest):
    try:
        csv_text = _load(req.content).to_csv()
        dictionary = load_dictionary(io.StringIO(csv_text), title=req.title)
        html = render_html(dictionary)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"html": html}


@app.post("/import/redcap")
def import_redcap(req: RedcapImportRequest):
    try:
        dd = convert_redcap(
            io.StringIO(req.content),
            provenance=req.provenance,
            allow_duplicates=req.allow_duplicates,
        )
    except (ConversionError, ValueError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"content": dd.to_json(), "elements": len(dd.elements)}
