"""Tests for the dd-edit MCP tools: functions directly, then over the protocol.

The shared primitives (detect, load, validate) are tested in ../../core; this
suite covers the MCP-specific query/author tools and the protocol wiring.
"""

from __future__ import annotations

import json

import pytest

from dd_edit_mcp import core, server


def _ids(dd_json_text: str) -> list[str]:
    return [e["id"] for e in json.loads(dd_json_text)["elements"]]

# Fixtures lifted from the sidecar's tests, so both agree on behaviour.
VALID_CSV = (
    "Id,Label,Datatype,Cardinality,Enumeration,Unit\n"
    "age,Age,integer,single,,years\n"
    'sex,Sex at birth,integer,single,"""1""=[Male] | ""2""=[Female]",\n'
)
BAD_CSV = "Id,Label,Datatype,Cardinality\nage,Age,notatype,single\n"

# A dictionary with sections and a missing unit, for the query tests.
SECTIONED_CSV = (
    "Id,Label,Datatype,Cardinality,Section,Unit\n"
    "age,Age,integer,single,Demographics,years\n"
    "sex,Sex,integer,single,Demographics,\n"
    "weight,Weight,float,single,Vitals,kg\n"
)


def test_add_element_appends_and_normalises():
    result = core.add_element(
        VALID_CSV,
        {"id": "weight", "label": "Body weight", "datatype": "float",
         "cardinality": "single", "unit": "kg"},
    )
    assert _ids(result.document) == ["age", "sex", "weight"]
    # The toolkit normalises the inserted element (fills defaults).
    added = json.loads(result.document)["elements"][-1]
    assert added["datatype"] == "float" and added["enumeration"] == []
    assert not [f for f in result.findings if f.level == "ERROR"]


def test_add_element_respects_index_order():
    # Element order is semantic, so index controls placement.
    result = core.add_element(
        VALID_CSV, {"id": "first", "label": "First", "datatype": "string"},
        index=0,
    )
    assert _ids(result.document) == ["first", "age", "sex"]


def test_add_element_does_not_mutate_input():
    before = VALID_CSV
    core.add_element(VALID_CSV, {"id": "x", "label": "X", "datatype": "string"})
    assert VALID_CSV == before  # pure: caller's document untouched


def test_add_element_duplicate_id_is_a_finding_not_an_error():
    # Adding a clashing id must surface as a finding, not raise — the caller
    # should see and fix it, matching the app's behaviour.
    result = core.add_element(
        VALID_CSV, {"id": "age", "label": "Age again", "datatype": "integer"},
    )
    assert _ids(result.document) == ["age", "sex", "age"]
    assert any("duplicate" in f.check.lower() or "duplicate" in f.message.lower()
               for f in result.findings)


def test_add_element_rejects_missing_id_and_unknown_fields():
    with pytest.raises(ValueError, match="id"):
        core.add_element(VALID_CSV, {"label": "No id", "datatype": "string"})
    with pytest.raises(ValueError, match="unknown"):
        core.add_element(VALID_CSV, {"id": "y", "datatypes": "string"})


def test_add_element_rejects_out_of_range_index():
    with pytest.raises(ValueError, match="out of range"):
        core.add_element(VALID_CSV, {"id": "z", "datatype": "string"}, index=99)


@pytest.mark.asyncio
async def test_add_element_over_mcp():
    from mcp.shared.memory import (
        create_connected_server_and_client_session as connect,
    )

    async with connect(server.mcp._mcp_server) as client:
        tools = {t.name for t in (await client.list_tools()).tools}
        assert {"validate_dictionary", "add_element"} <= tools

        res = await client.call_tool("add_element", {
            "content": VALID_CSV,
            "element": {"id": "weight", "label": "Body weight",
                        "datatype": "float", "unit": "kg"},
        })
        payload = json.loads(res.content[0].text)
        assert _ids(payload["document"]) == ["age", "sex", "weight"]
        assert payload["valid"] is True


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


# ---------------------------------------------------------------- queries


def test_list_elements_and_filters():
    all_els = core.list_elements(SECTIONED_CSV)
    assert [e["id"] for e in all_els] == ["age", "sex", "weight"]
    assert all_els[0] == {"id": "age", "label": "Age", "datatype": "integer",
                          "section": "Demographics"}

    demo = core.list_elements(SECTIONED_CSV, section="Demographics")
    assert [e["id"] for e in demo] == ["age", "sex"]

    floats = core.list_elements(SECTIONED_CSV, datatype="float")
    assert [e["id"] for e in floats] == ["weight"]

    # Coverage query: which elements lack a unit? Only 'sex'.
    no_unit = core.list_elements(SECTIONED_CSV, missing_field="unit")
    assert [e["id"] for e in no_unit] == ["sex"]


def test_get_element():
    e = core.get_element(SECTIONED_CSV, "weight")
    assert e is not None and e["datatype"] == "float" and e["unit"] == "kg"
    assert core.get_element(SECTIONED_CSV, "nope") is None


def test_describe_dictionary():
    d = core.describe_dictionary(SECTIONED_CSV)
    assert d["elementCount"] == 3
    assert d["sections"] == ["Demographics", "Vitals"]
    assert d["datatypes"] == {"integer": 2, "float": 1}
    assert d["valid"] is True and d["errorCount"] == 0


def test_export_round_trips_and_rejects_unknown():
    as_json = core.export(SECTIONED_CSV, "json")
    assert json.loads(as_json)["format"] == "dd-json"
    assert "classes" in core.export(SECTIONED_CSV, "linkml")
    assert core.export(SECTIONED_CSV, "csv").startswith("Id,")
    with pytest.raises(ValueError, match="unknown format"):
        core.export(SECTIONED_CSV, "xml")


@pytest.mark.asyncio
async def test_query_tools_over_mcp():
    from mcp.shared.memory import (
        create_connected_server_and_client_session as connect,
    )

    async with connect(server.mcp._mcp_server) as client:
        names = {t.name for t in (await client.list_tools()).tools}
        assert {"list_elements", "get_element", "describe_dictionary",
                "export"} <= names

        res = await client.call_tool(
            "list_elements", {"content": SECTIONED_CSV, "missing_field": "unit"})
        payload = json.loads(res.content[0].text)
        assert payload["count"] == 1
        assert payload["elements"][0]["id"] == "sex"

        res = await client.call_tool(
            "describe_dictionary", {"content": SECTIONED_CSV})
        assert json.loads(res.content[0].text)["elementCount"] == 3
