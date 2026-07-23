"""Tests for the shared dd-edit core: detect, load, validate."""

from __future__ import annotations

import dd_edit_core as core

# Fixtures shared with the sidecar and MCP suites, so all three agree.
VALID_CSV = (
    "Id,Label,Datatype,Cardinality,Enumeration,Unit\n"
    "age,Age,integer,single,,years\n"
    'sex,Sex at birth,integer,single,"""1""=[Male] | ""2""=[Female]",\n'
)
BAD_CSV = "Id,Label,Datatype,Cardinality\nage,Age,notatype,single\n"


def test_detect_formats():
    assert core.detect(VALID_CSV) == "csv"
    assert core.detect('{"format":"dd-json"}') == "json"
    assert core.detect("classes:\n  X: {}\n") == "linkml"


def test_load_round_trips_csv_to_json():
    dd = core.load(VALID_CSV)
    assert dd.ids == ("age", "sex")


def test_validate_flags_unknown_datatype():
    findings = core.validate_document(BAD_CSV)
    assert any(f.level == "ERROR" and "datatype" in f.check for f in findings)


def test_valid_document_has_no_errors():
    # INFO/WARNING findings are allowed; only ERRORs make a document invalid.
    findings = core.validate_document(VALID_CSV)
    assert not [f for f in findings if f.level == "ERROR"]


def test_finding_as_dict_wire_shape():
    f = core.validate_document(BAD_CSV)[0]
    d = f.as_dict()
    assert set(d) == {
        "level", "check", "message", "line", "column", "value",
        "elementIndex", "elementId", "suggestion",
    }
