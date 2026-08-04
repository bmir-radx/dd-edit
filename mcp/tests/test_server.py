"""Tests for the dd-edit MCP tools: functions directly, then over the protocol.

The shared primitives (detect, load, validate) are tested in ../../core; this
suite covers the MCP-specific query/author tools and the protocol wiring.
"""

from __future__ import annotations

import json

import pytest
from mcp.client import Client
from mcp.client._memory import InMemoryTransport

from dd_edit_mcp import core, server


def _ids(dd_json_text: str) -> list[str]:
    return [e["id"] for e in json.loads(dd_json_text)["elements"]]


def connect() -> Client:
    """An MCP client wired to our server in-process, no network or subprocess.

    The protocol round-trips below are what catch a tool that is broken at the
    MCP layer rather than in core — a bad signature, an unserialisable result.
    """
    return Client(InMemoryTransport(server.mcp))


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


def test_add_element_rejects_a_datatype_the_model_cannot_hold():
    # Mirrors test_edit_element_rejects_a_datatype_the_model_cannot_hold: unlike
    # a duplicate id, the toolkit's model refuses to hold an unknown datatype at
    # all, so this raises rather than returning findings. The message must name
    # the element and the bad value, not a line of the internal CSV round-trip.
    with pytest.raises(ValueError) as exc:
        core.add_element(
            VALID_CSV, {"id": "x", "label": "X", "datatype": "notatype"},
        )
    assert "notatype" in str(exc.value) and "'x'" in str(exc.value)
    # The toolkit's "Line N:" addresses the internal CSV, so it must not survive.
    assert "Line" not in str(exc.value)


def test_add_element_rejects_out_of_range_index():
    with pytest.raises(ValueError, match="out of range"):
        core.add_element(VALID_CSV, {"id": "z", "datatype": "string"}, index=99)


def test_edit_element_changes_only_named_fields():
    before = json.loads(core.export(SECTIONED_CSV, "json"))["elements"][0]
    result = core.edit_element(SECTIONED_CSV, "age", {"unit": "months"})
    after = json.loads(result.document)["elements"][0]

    assert after["unit"] == "months"
    # Every other field of the element survives untouched.
    assert {k: v for k, v in after.items() if k != "unit"} == {
        k: v for k, v in before.items() if k != "unit"
    }
    # And the other elements are left alone.
    assert _ids(result.document) == ["age", "sex", "weight"]
    assert not [f for f in result.findings if f.level == "ERROR"]


def test_edit_element_null_clears_a_field():
    # null is the app's "cleared" marker for optional scalars, so it must clear
    # here too rather than being ignored or written as "".
    result = core.edit_element(SECTIONED_CSV, "age", {"unit": None})
    assert json.loads(result.document)["elements"][0]["unit"] is None


def test_edit_element_does_not_mutate_input():
    before = SECTIONED_CSV
    core.edit_element(SECTIONED_CSV, "age", {"label": "Age in years"})
    assert SECTIONED_CSV == before  # pure: caller's document untouched


def test_edit_element_renames_via_id():
    result = core.edit_element(SECTIONED_CSV, "age", {"id": "age_years"})
    assert _ids(result.document) == ["age_years", "sex", "weight"]


def test_edit_element_rename_onto_existing_id_is_a_finding_not_an_error():
    # Same rule as add_element: a clashing id surfaces as a finding so the
    # caller can see and fix it, matching the app.
    result = core.edit_element(SECTIONED_CSV, "age", {"id": "sex"})
    assert _ids(result.document) == ["sex", "sex", "weight"]
    assert any("duplicate" in f.check.lower() or "duplicate" in f.message.lower()
               for f in result.findings)


def test_edit_element_rejects_a_datatype_the_model_cannot_hold():
    # Unlike a duplicate id (which becomes a finding), the toolkit's model
    # refuses to hold an unknown datatype at all — from_json raises. So this is
    # a ValueError, and the message must name the field and the bad value
    # rather than leaking a line number from the internal CSV round-trip.
    with pytest.raises(ValueError) as exc:
        core.edit_element(SECTIONED_CSV, "age", {"datatype": "notatype"})
    assert "datatype" in str(exc.value) and "notatype" in str(exc.value)
    assert "age" in str(exc.value)
    # The toolkit's "Line N:" addresses the internal CSV, so it must not survive.
    assert "Line" not in str(exc.value)


def test_a_malformed_precondition_raises_from_both_editing_tools():
    # The other value kind the model cannot hold; both tools must agree, and
    # neither may leak the internal CSV line number.
    with pytest.raises(ValueError, match="Malformed precondition") as add_exc:
        core.add_element(
            SECTIONED_CSV,
            {"id": "p", "label": "P", "datatype": "integer",
             "precondition": "age >>> ("},
        )
    with pytest.raises(ValueError, match="Malformed precondition") as edit_exc:
        core.edit_element(SECTIONED_CSV, "age", {"precondition": "age >>> ("})
    assert "Line" not in str(add_exc.value)
    assert "Line" not in str(edit_exc.value)


def test_edit_element_rejects_unknown_id_fields_and_no_op():
    with pytest.raises(ValueError, match="no element with id"):
        core.edit_element(SECTIONED_CSV, "nope", {"unit": "kg"})
    with pytest.raises(ValueError, match="unknown"):
        core.edit_element(SECTIONED_CSV, "age", {"datatypes": "string"})
    with pytest.raises(ValueError, match="empty"):
        core.edit_element(SECTIONED_CSV, "age", {})


def test_edit_element_refuses_to_clear_required_fields():
    for field in ("id", "label", "datatype"):
        with pytest.raises(ValueError, match="required"):
            core.edit_element(SECTIONED_CSV, "age", {field: None})


# A dictionary the model tolerates but the validator flags: two elements share an
# id, so addressing one of them by id alone is ambiguous.
DUPLICATE_ID_CSV = (
    "Id,Label,Datatype,Cardinality\n"
    "age,Age A,integer,single\n"
    "age,Age B,integer,single\n"
    "sex,Sex,integer,single\n"
)

# 'weight' depends on 'age', so removing or renaming 'age' orphans the reference.
REFERENCING_CSV = (
    "Id,Label,Datatype,Cardinality,Precondition\n"
    "age,Age,integer,single,\n"
    "weight,Weight,float,single,age > 18\n"
)


def test_remove_element_by_id_and_by_index():
    by_id = core.remove_element(SECTIONED_CSV, "sex")
    assert _ids(by_id.document) == ["age", "weight"]

    by_index = core.remove_element(SECTIONED_CSV, index=0)
    assert _ids(by_index.document) == ["sex", "weight"]

    # Both together: the index must really be that element.
    both = core.remove_element(SECTIONED_CSV, "weight", index=2)
    assert _ids(both.document) == ["age", "sex"]


def test_remove_element_does_not_mutate_input():
    before = SECTIONED_CSV
    core.remove_element(SECTIONED_CSV, "age")
    assert SECTIONED_CSV == before  # pure: caller's document untouched


def test_remove_element_refuses_an_ambiguous_id():
    # The decision that distinguishes this from edit_element: a wrong delete is
    # invisible in the result, so guessing is not acceptable.
    with pytest.raises(ValueError, match="2 elements have id") as exc:
        core.remove_element(DUPLICATE_ID_CSV, "age")
    assert "positions 0, 1" in str(exc.value)
    assert "index" in str(exc.value)  # tells the caller how to disambiguate

    # ...and index resolves it, removing exactly the one asked for.
    second = core.remove_element(DUPLICATE_ID_CSV, "age", index=1)
    labels = [e["label"] for e in json.loads(second.document)["elements"]]
    assert labels == ["Age A", "Sex"]


def test_remove_element_rejects_index_id_mismatch():
    with pytest.raises(ValueError, match="has id 'sex', not 'age'"):
        core.remove_element(SECTIONED_CSV, "age", index=1)


def test_remove_element_rejects_no_target_unknown_id_and_bad_index():
    with pytest.raises(ValueError, match="nothing identified"):
        core.remove_element(SECTIONED_CSV)
    with pytest.raises(ValueError, match="no element with id"):
        core.remove_element(SECTIONED_CSV, "nope")
    with pytest.raises(ValueError, match="out of range"):
        core.remove_element(SECTIONED_CSV, index=99)
    with pytest.raises(ValueError, match="out of range"):
        core.remove_element(SECTIONED_CSV, index=-1)


def test_remove_element_orphans_a_reference_as_a_finding():
    # The reference text is not rewritten; the caller learns via findings.
    result = core.remove_element(REFERENCING_CSV, "age")
    assert _ids(result.document) == ["weight"]
    assert any(f.check == "unknown-precondition-field" and f.level == "ERROR"
               for f in result.findings)


def test_remove_last_element_yields_a_valid_empty_dictionary():
    doc = SECTIONED_CSV
    for element_id in ("age", "sex", "weight"):
        doc = core.remove_element(doc, element_id).document
    assert json.loads(doc)["elements"] == []
    assert core.describe_dictionary(doc)["elementCount"] == 0


def test_reorder_elements_permutes_and_preserves_content():
    before = json.loads(core.export(SECTIONED_CSV, "json"))["elements"]
    result = core.reorder_elements(SECTIONED_CSV, ["weight", "age", "sex"])

    assert _ids(result.document) == ["weight", "age", "sex"]
    # Only the sequence changed: every element is byte-for-byte the same object.
    after = json.loads(result.document)["elements"]
    assert {e["id"]: e for e in after} == {e["id"]: e for e in before}
    assert not [f for f in result.findings if f.level == "ERROR"]


def test_reorder_elements_does_not_mutate_input():
    before = SECTIONED_CSV
    core.reorder_elements(SECTIONED_CSV, ["sex", "weight", "age"])
    assert SECTIONED_CSV == before  # pure: caller's document untouched


def test_reorder_elements_identity_order_is_a_no_op():
    result = core.reorder_elements(SECTIONED_CSV, ["age", "sex", "weight"])
    assert _ids(result.document) == ["age", "sex", "weight"]


def test_reorder_elements_requires_an_exact_permutation():
    # Omitting an id would silently drop it — the main thing the whole-list
    # shape exists to prevent.
    with pytest.raises(ValueError, match="omitted: 'weight'"):
        core.reorder_elements(SECTIONED_CSV, ["sex", "age"])

    with pytest.raises(ValueError, match="not in the document: 'nope'"):
        core.reorder_elements(SECTIONED_CSV, ["age", "sex", "weight", "nope"])

    with pytest.raises(ValueError, match="listed twice: 'age'"):
        core.reorder_elements(SECTIONED_CSV, ["age", "age", "sex", "weight"])

    with pytest.raises(ValueError, match="order must be a list"):
        core.reorder_elements(SECTIONED_CSV, "age,sex,weight")


def test_reorder_elements_reports_every_discrepancy_at_once():
    # A caller fixing one problem at a time would need several round-trips.
    with pytest.raises(ValueError) as exc:
        core.reorder_elements(SECTIONED_CSV, ["age", "age", "nope"])
    message = str(exc.value)
    assert "not in the document: 'nope'" in message
    assert "listed twice: 'age'" in message
    assert "omitted:" in message and "'sex'" in message and "'weight'" in message


def test_reorder_elements_refuses_a_document_with_duplicate_ids():
    # Same reasoning as remove_element: an id that names two elements cannot
    # express a position.
    with pytest.raises(ValueError, match="ids must be unique") as exc:
        core.reorder_elements(DUPLICATE_ID_CSV, ["sex", "age", "age"])
    assert "'age'" in str(exc.value)


def test_reorder_elements_keeps_a_dangling_reference_dangling():
    # Reordering cannot fix or break a reference; the pre-existing finding (or
    # lack of one) is unaffected. 'weight' still refers to 'age', which is present.
    result = core.reorder_elements(REFERENCING_CSV, ["weight", "age"])
    assert _ids(result.document) == ["weight", "age"]
    assert not [f for f in result.findings if f.level == "ERROR"]


@pytest.mark.asyncio
async def test_reorder_elements_over_mcp():
    async with connect() as client:
        assert "reorder_elements" in {
            t.name for t in (await client.list_tools()).tools
        }

        res = await client.call_tool("reorder_elements", {
            "content": SECTIONED_CSV, "order": ["weight", "sex", "age"],
        })
        payload = json.loads(res.content[0].text)
        assert _ids(payload["document"]) == ["weight", "sex", "age"]
        assert payload["valid"] is True


@pytest.mark.asyncio
async def test_remove_element_over_mcp():
    async with connect() as client:
        assert "remove_element" in {
            t.name for t in (await client.list_tools()).tools
        }

        res = await client.call_tool("remove_element", {
            "content": SECTIONED_CSV, "element_id": "sex",
        })
        payload = json.loads(res.content[0].text)
        assert _ids(payload["document"]) == ["age", "weight"]
        assert payload["valid"] is True


@pytest.mark.asyncio
async def test_edit_element_over_mcp():
    async with connect() as client:
        assert "edit_element" in {
            t.name for t in (await client.list_tools()).tools
        }

        res = await client.call_tool("edit_element", {
            "content": SECTIONED_CSV,
            "element_id": "sex",
            "changes": {"label": "Sex at birth", "unit": None},
        })
        payload = json.loads(res.content[0].text)
        edited = json.loads(payload["document"])["elements"][1]
        assert edited["label"] == "Sex at birth" and edited["unit"] is None
        assert payload["valid"] is True


@pytest.mark.asyncio
async def test_add_element_over_mcp():
    async with connect() as client:
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
    async with connect() as client:
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
    async with connect() as client:
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
