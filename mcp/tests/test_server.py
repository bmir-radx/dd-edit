"""Tests for the dd-edit MCP spike: core directly, then over the protocol."""

from __future__ import annotations

import json

import pytest

from dd_edit_mcp import core, server

# Fixtures lifted from the sidecar's tests, so both agree on behaviour.
VALID_CSV = (
    "Id,Label,Datatype,Cardinality,Enumeration,Unit\n"
    "age,Age,integer,single,,years\n"
    'sex,Sex at birth,integer,single,"""1""=[Male] | ""2""=[Female]",\n'
)
BAD_CSV = "Id,Label,Datatype,Cardinality\nage,Age,notatype,single\n"


def test_core_detects_formats():
    assert core.detect(VALID_CSV) == "csv"
    assert core.detect('{"format":"dd-json"}') == "json"
    assert core.detect("classes:\n  X: {}\n") == "linkml"


def test_core_flags_unknown_datatype():
    findings = core.validate_document(BAD_CSV)
    assert any(f.level == "ERROR" and "datatype" in f.check for f in findings)


def test_core_valid_document_has_no_errors():
    # INFO/WARNING findings are allowed; only ERRORs make a document invalid.
    findings = core.validate_document(VALID_CSV)
    assert not [f for f in findings if f.level == "ERROR"]


@pytest.mark.asyncio
async def test_validate_dictionary_over_mcp():
    from mcp.shared.memory import (
        create_connected_server_and_client_session as connect,
    )

    async with connect(server.mcp._mcp_server) as client:
        tools = await client.list_tools()
        assert "validate_dictionary" in {t.name for t in tools.tools}

        res = await client.call_tool("validate_dictionary", {"content": BAD_CSV})
        payload = json.loads(res.content[0].text)
        assert payload["detected"] == "csv"
        assert payload["valid"] is False
        assert any(f["check"] == "unknown-datatype" for f in payload["findings"])

        ok = await client.call_tool("validate_dictionary", {"content": VALID_CSV})
        assert json.loads(ok.content[0].text)["valid"] is True
