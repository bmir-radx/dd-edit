"""Tests for the dd-edit MCP tools: functions directly, then over the protocol.

The shared primitives (detect, load, validate) are tested in ../../core; this
suite covers the MCP-specific query/author tools and the protocol wiring.
"""

from __future__ import annotations

import hashlib
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


# ----------------------------------------------------------------- sessions
#
# Phase 2. The store is exercised directly, then the dual-mode tools over the
# protocol. The point of the design is that the 70-odd stateless tests above keep
# passing untouched — session mode is an addition, not a replacement.


@pytest.fixture
def store():
    from dd_edit_mcp.sessions import SessionStore

    return SessionStore()


@pytest.fixture
def clean_sessions():
    """Isolate the server's module-level store between tests."""
    from dd_edit_mcp.sessions import SessionStore

    original = server.sessions
    server.sessions = SessionStore()
    yield server.sessions
    server.sessions = original


def test_store_holds_a_document_and_counts_revisions(store):
    session = store.open(core.export(SECTIONED_CSV, "json"))
    assert session.revision == 0
    assert session.summary()["elementCount"] == 3

    store.apply(session.id, lambda doc: core.edit_element(
        doc, "age", {"unit": "months"}))
    store.apply(session.id, lambda doc: core.add_element(
        doc, {"id": "new", "label": "N", "datatype": "string"}))

    held = store.get(session.id)
    assert held.revision == 2
    assert _ids(held.document) == ["age", "sex", "weight", "new"]
    assert json.loads(held.document)["elements"][0]["unit"] == "months"


def test_store_leaves_the_document_untouched_when_an_edit_fails(store):
    session = store.open(core.export(SECTIONED_CSV, "json"))
    before, revision = session.document, session.revision

    # An unknown datatype is the kind the model cannot hold, so it raises.
    with pytest.raises(ValueError, match="notatype"):
        store.apply(session.id, lambda doc: core.edit_element(
            doc, "age", {"datatype": "notatype"}))

    held = store.get(session.id)
    assert held.document == before  # no partial application
    assert held.revision == revision  # and the revision did not move


def test_store_explains_an_unknown_session(store):
    store.open(core.export(SECTIONED_CSV, "json"))  # so one is open
    with pytest.raises(ValueError, match="no open session 'nope'") as exc:
        store.get("nope")
    # The message names what *is* open, since a stale handle is the likely cause.
    assert "s1" in str(exc.value)


def test_store_close_returns_the_document_and_frees_the_id(store):
    session = store.open(core.export(SECTIONED_CSV, "json"))
    closed = store.close(session.id)
    assert _ids(closed.document) == ["age", "sex", "weight"]

    with pytest.raises(ValueError, match="no open session"):
        store.get(session.id)
    assert store.list() == []


def test_store_keeps_sessions_independent(store):
    a = store.open(core.export(SECTIONED_CSV, "json"))
    b = store.open(core.export(SECTIONED_CSV, "json"))

    store.apply(a.id, lambda doc: core.remove_element(doc, "age"))

    assert _ids(store.get(a.id).document) == ["sex", "weight"]
    assert _ids(store.get(b.id).document) == ["age", "sex", "weight"]
    assert len(store.list()) == 2


@pytest.mark.asyncio
async def test_session_lifecycle_over_mcp(clean_sessions):
    async with connect() as client:
        names = {t.name for t in (await client.list_tools()).tools}
        assert {"open_dictionary", "close_dictionary", "list_sessions"} <= names

        opened = json.loads((await client.call_tool(
            "open_dictionary", {"content": SECTIONED_CSV})).content[0].text)
        session_id = opened["sessionId"]
        assert opened["revision"] == 0 and opened["elementCount"] == 3

        # An edit in session mode returns a summary, not the document.
        edited = json.loads((await client.call_tool("edit_element", {
            "session_id": session_id,
            "element_id": "age",
            "changes": {"unit": "months"},
        })).content[0].text)
        assert "document" not in edited
        assert edited["revision"] == 1 and edited["valid"] is True

        # Queries read the held document.
        listed = json.loads((await client.call_tool(
            "list_elements", {"session_id": session_id})).content[0].text)
        assert listed["count"] == 3

        got = json.loads((await client.call_tool("get_element", {
            "session_id": session_id, "element_id": "age"})).content[0].text)
        assert got["element"]["unit"] == "months"

        # And closing hands the document back.
        closed = json.loads((await client.call_tool(
            "close_dictionary", {"session_id": session_id})).content[0].text)
        assert json.loads(closed["document"])["elements"][0]["unit"] == "months"
        assert closed["revision"] == 1

        remaining = json.loads(
            (await client.call_tool("list_sessions", {})).content[0].text)
        assert remaining["count"] == 0


@pytest.mark.asyncio
async def test_session_and_stateless_modes_agree(clean_sessions):
    """The same edit must mean the same thing in both modes."""
    async with connect() as client:
        stateless = json.loads((await client.call_tool("edit_element", {
            "content": SECTIONED_CSV,
            "element_id": "age",
            "changes": {"unit": "months", "description": "Age"},
        })).content[0].text)

        opened = json.loads((await client.call_tool(
            "open_dictionary", {"content": SECTIONED_CSV})).content[0].text)
        await client.call_tool("edit_element", {
            "session_id": opened["sessionId"],
            "element_id": "age",
            "changes": {"unit": "months", "description": "Age"},
        })
        closed = json.loads((await client.call_tool(
            "close_dictionary", {"session_id": opened["sessionId"]})
        ).content[0].text)

        assert json.loads(closed["document"]) == json.loads(
            stateless["document"])


@pytest.mark.asyncio
async def test_tools_reject_both_or_neither_document(clean_sessions):
    async with connect() as client:
        for arguments in (
            {"element_id": "age", "changes": {"unit": "kg"}},  # neither
            {  # both
                "element_id": "age", "changes": {"unit": "kg"},
                "content": SECTIONED_CSV, "session_id": "s1",
            },
        ):
            res = await client.call_tool("edit_element", arguments)
            assert res.is_error is True
            assert "not both and not neither" in res.content[0].text


@pytest.mark.asyncio
async def test_session_replies_do_not_scale_with_the_document(clean_sessions):
    """The property the whole phase exists for.

    A session reply must stay small however big the dictionary is. Returning every
    finding broke that — a 60-element dictionary carries 60 INFO findings, which
    dwarfed the ~100-byte summary — so errors come back in full and the rest as
    counts by check.
    """
    rows = ["Id,Label,Datatype,Cardinality,Unit,Section,Description"]
    for i in range(60):
        rows.append(f"f{i:02d},Field {i},integer,single,years,Demo,A measure")
    big = "\n".join(rows) + "\n"

    async with connect() as client:
        opened = json.loads((await client.call_tool(
            "open_dictionary", {"content": big})).content[0].text)
        reply = await client.call_tool("edit_element", {
            "session_id": opened["sessionId"],
            "element_id": "f00",
            "changes": {"unit": "months"},
        })
        text = reply.content[0].text
        payload = json.loads(text)

        # A summary, not a document, and not 60 findings either.
        assert "document" not in payload
        assert len(text) < 1000, f"session reply grew to {len(text)} chars"
        assert payload["errors"] == []  # nothing to act on
        assert payload["otherFindings"]  # but the INFO checks are still counted
        assert payload["elementCount"] == 60


@pytest.mark.asyncio
async def test_session_errors_come_back_in_full(clean_sessions):
    async with connect() as client:
        opened = json.loads((await client.call_tool(
            "open_dictionary", {"content": SECTIONED_CSV})).content[0].text)
        # A duplicate id is a finding the caller must act on.
        payload = json.loads((await client.call_tool("edit_element", {
            "session_id": opened["sessionId"],
            "element_id": "age",
            "changes": {"id": "sex"},
        })).content[0].text)

        assert payload["valid"] is False
        assert any(e["check"] == "duplicate-id" for e in payload["errors"])

        # And the full list is still reachable through the session.
        full = json.loads((await client.call_tool(
            "validate_dictionary", {"session_id": opened["sessionId"]})
        ).content[0].text)
        assert any(f["check"] == "duplicate-id" for f in full["findings"])


@pytest.mark.asyncio
async def test_a_returned_document_can_be_fed_straight_back(clean_sessions):
    """The stateless workflow: edit, then edit the result.

    Regression test. When `content` was first made optional it was annotated
    `str | None`, and the SDK pre-parses a string argument into JSON whenever the
    annotation is not exactly `str` (func_metadata.pre_parse_json) — so a dd-json
    document arrived as a dict and was rejected. The annotation must stay plain
    `str`, with "" meaning absent, or chaining silently breaks.
    """
    async with connect() as client:
        first = await client.call_tool("edit_element", {
            "content": SECTIONED_CSV,
            "element_id": "age",
            "changes": {"unit": "months"},
        })
        document = json.loads(first.content[0].text)["document"]

        second = await client.call_tool("edit_element", {
            "content": document,
            "element_id": "sex",
            "changes": {"unit": "1"},
        })
        assert second.is_error is False
        elements = json.loads(json.loads(second.content[0].text)["document"])
        assert elements["elements"][0]["unit"] == "months"  # first edit survived
        assert elements["elements"][1]["unit"] == "1"


@pytest.mark.asyncio
async def test_content_parameter_is_declared_as_a_plain_string(clean_sessions):
    # The guard for the bug above: `anyOf: [string, null]` is what triggers the
    # SDK's pre-parsing, so assert the schema the SDK actually generates.
    async with connect() as client:
        tools = {t.name: t for t in (await client.list_tools()).tools}
        for name in ("edit_element", "add_element", "remove_element",
                     "reorder_elements", "list_elements", "export"):
            schema = tools[name].input_schema["properties"]["content"]
            assert schema.get("type") == "string", (
                f"{name}.content must be a plain string, got {schema}"
            )


@pytest.mark.asyncio
async def test_import_redcap_can_open_a_session(clean_sessions):
    async with connect() as client:
        opened = json.loads((await client.call_tool("import_redcap", {
            "content": REDCAP_CSV, "open_session": True,
        })).content[0].text)

        # A converted dictionary usually needs follow-up edits, so it can go
        # straight into a session instead of being shipped back first.
        assert "document" not in opened
        assert opened["elementCount"] == 3 and opened["revision"] == 0

        closed = json.loads((await client.call_tool(
            "close_dictionary", {"session_id": opened["sessionId"]})
        ).content[0].text)
        assert _ids(closed["document"]) == ["age", "sex", "weight"]


# -------------------------------------------------------------- term lookup
#
# lookup_terms is the only tool that leaves the process. These tests stub the
# upstream call, so the suite stays offline and deterministic; the live path is
# exercised by test_lookup_terms_live, which is opt-in.

NCIT_AGE = "http://purl.obolibrary.org/obo/NCIT_C25150"


@pytest.fixture
def stub_lookup(monkeypatch):
    """Replace the network call, recording what it was asked for."""
    calls = []

    def fake_lookup_labels(terms, **kwargs):
        terms = list(terms)
        calls.append({"terms": terms, "kwargs": kwargs})
        # Resolve anything NCIT-ish; everything else is a miss.
        return {t: "Age" for t in terms if "NCIT" in t}

    import dd_core.terms_lookup as tl

    monkeypatch.setattr(tl, "lookup_labels", fake_lookup_labels)
    return calls


def test_lookup_terms_returns_labels_and_omits_misses(stub_lookup):
    labels = core.lookup_terms([NCIT_AGE, "http://example.org/nope"])
    assert labels == {NCIT_AGE: "Age"}
    # A miss is absent, not an error and not an empty string.
    assert "http://example.org/nope" not in labels


def test_lookup_terms_dedupes_preserving_order_and_drops_blanks(stub_lookup):
    core.lookup_terms([NCIT_AGE, "  ", NCIT_AGE, "http://example.org/b", ""])
    assert stub_lookup[0]["terms"] == [NCIT_AGE, "http://example.org/b"]


def test_lookup_terms_caps_the_batch(stub_lookup):
    core.lookup_terms([f"http://example.org/t{i}" for i in range(150)])
    assert len(stub_lookup[0]["terms"]) == core.MAX_TERMS_PER_LOOKUP


def test_lookup_terms_short_circuits_an_empty_request(stub_lookup):
    assert core.lookup_terms([]) == {}
    assert core.lookup_terms(["", "   "]) == {}
    assert stub_lookup == []  # never called upstream


def test_lookup_terms_wraps_a_transport_failure(monkeypatch):
    import dd_core.terms_lookup as tl

    def boom(terms, **kwargs):
        raise OSError("connection refused")

    monkeypatch.setattr(tl, "lookup_labels", boom)
    with pytest.raises(ValueError, match="term lookup failed"):
        core.lookup_terms([NCIT_AGE])


def test_lookup_terms_rejects_a_non_list():
    with pytest.raises(ValueError, match="must be a list"):
        core.lookup_terms(NCIT_AGE)


@pytest.mark.asyncio
async def test_lookup_terms_over_mcp(stub_lookup):
    async with connect() as client:
        assert "lookup_terms" in {
            t.name for t in (await client.list_tools()).tools
        }

        res = await client.call_tool("lookup_terms", {
            "terms": [NCIT_AGE, "http://example.org/nope"],
        })
        payload = json.loads(res.content[0].text)
        assert payload["labels"] == {NCIT_AGE: "Age"}
        # The server adds the explicit miss list the raw call cannot give.
        assert payload["unresolved"] == ["http://example.org/nope"]


@pytest.mark.live
def test_lookup_terms_live():
    """The real OLS4 path. Run with: pytest -m live (needs network)."""
    labels = core.lookup_terms([NCIT_AGE, "http://example.org/nonexistent_xyz"])
    assert labels.get(NCIT_AGE) == "Age"
    assert "http://example.org/nonexistent_xyz" not in labels


# ------------------------------------------------------------ redcap import

# A REDCap export's full 18-column header, as REDCap actually writes it.
_REDCAP_HEADER = (
    '"Variable / Field Name","Form Name","Section Header","Field Type",'
    '"Field Label","Choices, Calculations, OR Slider Labels","Field Note",'
    '"Text Validation Type OR Show Slider Number","Text Validation Min",'
    '"Text Validation Max","Identifier?",'
    '"Branching Logic (Show field only if...)","Required Field?",'
    '"Custom Alignment","Question Number (surveys only)","Matrix Group Name",'
    '"Matrix Ranking?","Field Annotation"\n'
)
REDCAP_CSV = _REDCAP_HEADER + (
    "age,demo,Demographics,text,Age,,,integer,0,120,,,y,,,,,\n"
    'sex,demo,,radio,Sex at birth,"1, Male | 2, Female",,,,,,,y,,,,,\n'
    'weight,demo,,text,Weight,,kg please,number,,,,"[age] > 18",,,,,,\n'
)
REDCAP_DUPLICATE_CSV = _REDCAP_HEADER + (
    "age,form1,,text,Age,,,integer,,,,,,,,,,\n"
    "age,form2,,text,Age again,,,integer,,,,,,,,,,\n"
)


def test_import_redcap_converts_types_and_choices():
    result = core.import_redcap(REDCAP_CSV, provenance="Demo study")
    elements = json.loads(result.document)["elements"]

    assert [e["id"] for e in elements] == ["age", "sex", "weight"]
    assert elements[0]["datatype"] == "integer"
    # A REDCap radio with choices becomes an enumeration.
    assert [i["value"] for i in elements[1]["enumeration"]] == ["1", "2"]
    assert [i["label"] for i in elements[1]["enumeration"]] == ["Male", "Female"]
    # provenance is the only record of where these came from.
    assert all(e["provenance"] == "Demo study" for e in elements)


def test_import_redcap_drops_branching_logic():
    # Documented as deliberate: REDCap's branching grammar is not the spec's
    # precondition grammar, so it is dropped rather than mistranslated.
    result = core.import_redcap(REDCAP_CSV)
    weight = json.loads(result.document)["elements"][2]
    assert weight["precondition"] is None


def test_import_redcap_findings_are_the_todo_list():
    # REDCap carries no units, so a converted numeric field is incomplete.
    result = core.import_redcap(REDCAP_CSV)
    assert any(f.check == "missing-unit" for f in result.findings)


def test_import_redcap_duplicate_handling():
    with pytest.raises(ValueError, match="duplicate"):
        core.import_redcap(REDCAP_DUPLICATE_CSV)

    # allow_duplicates keeps the FIRST occurrence and drops the rest.
    kept = core.import_redcap(REDCAP_DUPLICATE_CSV, allow_duplicates=True)
    elements = json.loads(kept.document)["elements"]
    assert [e["label"] for e in elements] == ["Age"]


def test_import_redcap_rejects_a_non_redcap_file():
    with pytest.raises(ValueError, match="cannot convert REDCap dictionary"):
        core.import_redcap(SECTIONED_CSV)  # a dd CSV, not a REDCap export


@pytest.mark.asyncio
async def test_import_redcap_over_mcp():
    async with connect() as client:
        assert "import_redcap" in {
            t.name for t in (await client.list_tools()).tools
        }

        res = await client.call_tool("import_redcap", {
            "content": REDCAP_CSV, "provenance": "Demo study",
        })
        payload = json.loads(res.content[0].text)
        assert payload["elementCount"] == 3
        assert _ids(payload["document"]) == ["age", "sex", "weight"]


# --------------------------------------------------- documented tool surface
#
# The tool docstrings are the product surface: an LLM uses them without reading
# the source. These tests pin the concrete claims those docstrings make, so a
# toolkit change cannot quietly turn the documentation into a lie.

GRAMMAR_FIXTURE_CSV = (
    "Id,Label,Datatype,Cardinality,Enumeration\n"
    "age,Age,integer,single,\n"
    'sex,Sex,integer,single,"""1""=[M] | ""2""=[F]"\n'
    'race,Race,integer,multiple,"""1""=[A] | ""2""=[B] | ""3""=[C]"\n'
    "symptoms,Symptoms,string,multiple,\n"
    "consent,Consent,string,single,\n"
    "target,Target,string,single,\n"
)


@pytest.mark.parametrize("expression", [
    'age >= 18',
    'sex = "1"',
    'age >= 18 and sex <> "2"',
    'race in {"1", "2", "3"}',
    'symptoms contains "fever"',
    'consent <> ""',
])
def test_documented_precondition_examples_are_accepted(expression):
    # Every example in edit_element's "Precondition grammar" section must parse
    # and be semantically clean against the fixture it was written for.
    result = core.edit_element(
        GRAMMAR_FIXTURE_CSV, "target", {"precondition": expression}
    )
    assert not [f for f in result.findings if f.level == "ERROR"]


def test_documented_enumeration_shape_round_trips():
    # edit_element documents [{"value": ..., "label": ..., "iri": ...}].
    result = core.edit_element(GRAMMAR_FIXTURE_CSV, "sex", {
        "enumeration": [
            {"value": "1", "label": "Male"},
            {"value": "9", "label": "Other", "iri": "http://example.org/9"},
        ],
    })
    enum = json.loads(result.document)["elements"][1]["enumeration"]
    assert enum == [
        {"value": "1", "label": "Male", "iri": None},
        {"value": "9", "label": "Other", "iri": "http://example.org/9"},
    ]


def test_enumeration_silently_drops_valueless_items_as_documented():
    # Documented as a trap rather than fixed here: the toolkit drops these
    # without an error, so the docstring warns "always send objects with a
    # value". If the toolkit ever starts rejecting them, this test fails and the
    # warning should be rewritten.
    label_only = core.edit_element(
        GRAMMAR_FIXTURE_CSV, "sex", {"enumeration": [{"label": "Male"}]}
    )
    assert json.loads(label_only.document)["elements"][1]["enumeration"] == []

    bare_strings = core.edit_element(
        GRAMMAR_FIXTURE_CSV, "sex", {"enumeration": ["1", "2"]}
    )
    assert json.loads(bare_strings.document)["elements"][1]["enumeration"] == []


def test_terms_is_a_list_of_strings_as_documented():
    ok = core.edit_element(
        GRAMMAR_FIXTURE_CSV, "sex", {"terms": ["http://purl.org/x_1"]}
    )
    assert json.loads(ok.document)["elements"][1]["terms"] == [
        "http://purl.org/x_1"
    ]


@pytest.mark.parametrize("expression,check", [
    ("age >>> (", "malformed-precondition"),
    ("nope > 1", "unknown-precondition-field"),
    ("consent > 5", "invalid-precondition-comparison"),
    ('age contains "x"', "invalid-precondition-contains"),
])
def test_documented_precondition_checks_exist(expression, check):
    # validate_dictionary names these checks; they must be the real strings.
    # A malformed expression cannot be written through edit_element (the model
    # refuses to hold it — the asymmetry the docstring calls out), so put it in
    # the CSV directly, where the validator reads the text before the model sees it.
    doc = GRAMMAR_FIXTURE_CSV.replace(
        "Id,Label,Datatype,Cardinality,Enumeration\n",
        "Id,Label,Datatype,Cardinality,Enumeration,Precondition\n",
    ).replace(
        "target,Target,string,single,\n",
        # Inner quotes must be doubled to survive the CSV field they sit in.
        'target,Target,string,single,,"{}"\n'.format(
            expression.replace('"', '""')
        ),
    )
    assert any(f.check == check for f in core.validate_document(doc)), (
        f"{check!r} not raised for {expression!r}"
    )


def test_and_binds_tighter_than_or_as_documented():
    from dd_core.grammar import parse_precondition

    # "a or b and c" groups as a OR (b AND c) — so the top node is the Or.
    loose = parse_precondition("age > 1 or age > 2 and age > 3")
    assert type(loose).__name__ == "Or"
    # Parenthesising overrides it, which is what the "(" expression ")" form is for.
    grouped = parse_precondition("(age > 1 or age > 2) and age > 3")
    assert type(grouped).__name__ == "And"


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


def test_export_compact_is_smaller_but_lossless():
    full = core.export(SECTIONED_CSV, "json")
    compact = core.export(SECTIONED_CSV, "json", compact=True)

    assert len(compact) < len(full)
    # The point of the flag: it omits null/empty fields...
    assert "null" not in compact
    # ...but reloading it gives back exactly the full document, because those
    # fields are precisely the ones load() fills in again.
    assert json.loads(core.export(compact, "json")) == json.loads(full)


def test_export_default_stays_the_full_form():
    # The app writes the full form, so the default must not change under it.
    default = json.loads(core.export(SECTIONED_CSV, "json"))
    assert all("unit" in e for e in default["elements"])
    assert any(e["unit"] is None for e in default["elements"])


def test_compact_is_accepted_as_input_by_the_editing_tools():
    # A caller holding a compact document must be able to edit it directly,
    # or the size saving would come at the cost of an extra conversion.
    compact = core.export(SECTIONED_CSV, "json", compact=True)

    edited = core.edit_element(compact, "age", {"description": "Age in years"})
    element = json.loads(edited.document)["elements"][0]
    assert element["description"] == "Age in years"
    assert element["unit"] == "years"  # untouched field survived the round-trip

    # And clearing a field that compact omits still works.
    cleared = core.edit_element(compact, "age", {"unit": None})
    assert json.loads(cleared.document)["elements"][0]["unit"] is None


def test_editing_tools_can_return_compact():
    # Without this the flag only saves on the input leg: the caller would have to
    # make a second export call to shrink each result.
    full = core.edit_element(SECTIONED_CSV, "age", {"description": "X"})
    compact = core.edit_element(
        SECTIONED_CSV, "age", {"description": "X"}, compact=True
    )

    assert len(compact.document) < len(full.document)
    assert "null" not in compact.document
    # Same document, just written smaller — and identical findings.
    assert json.loads(core.export(compact.document, "json")) == json.loads(
        full.document
    )
    assert [f.as_dict() for f in compact.findings] == [
        f.as_dict() for f in full.findings
    ]


def test_every_editing_tool_accepts_compact():
    # One shared tail (_apply) means these cannot drift apart, but the wiring is
    # per-tool, so check each one actually passes the flag through.
    results = [
        core.add_element(
            SECTIONED_CSV, {"id": "new", "label": "N", "datatype": "string"},
            compact=True,
        ),
        core.edit_element(SECTIONED_CSV, "age", {"unit": "months"}, compact=True),
        core.remove_element(SECTIONED_CSV, "sex", compact=True),
        core.reorder_elements(
            SECTIONED_CSV, ["weight", "age", "sex"], compact=True
        ),
        core.import_redcap(REDCAP_CSV, compact=True),
    ]
    for result in results:
        assert "null" not in result.document


def test_compact_ignored_for_non_json_formats():
    assert core.export(SECTIONED_CSV, "csv", compact=True) == core.export(
        SECTIONED_CSV, "csv"
    )
    assert core.export(SECTIONED_CSV, "linkml", compact=True) == core.export(
        SECTIONED_CSV, "linkml"
    )


@pytest.mark.asyncio
async def test_export_compact_over_mcp():
    async with connect() as client:
        res = await client.call_tool("export", {
            "content": SECTIONED_CSV, "to": "json", "compact": True,
        })
        payload = json.loads(res.content[0].text)
        assert payload["format"] == "json"
        assert "null" not in payload["content"]


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


# --- save_dictionary -----------------------------------------------------------
#
# The only tool that touches the filesystem, so these lean on the refusals rather
# than the happy path: a save that escapes its root, or silently discards someone
# else's edit, is the failure that matters.


def test_save_writes_and_reports_without_returning_the_document(tmp_path):
    out = tmp_path / "dd.csv"
    result = core.save_document(VALID_CSV, str(out), root=tmp_path)

    assert out.exists()
    assert result["elementCount"] == 2
    assert result["valid"] is True
    assert result["existed"] is False
    assert result["bytesWritten"] == len(out.read_bytes())
    # The point of the tool: no document in the reply.
    assert "content" not in result and "document" not in result
    # And what landed reloads to the same dictionary.
    assert _ids(core.export(out.read_text(), "json")) == ["age", "sex"]


def test_save_infers_format_from_the_extension(tmp_path):
    for name, marker in [
        ("dd.csv", "Id,"), ("dd.yaml", "classes:"), ("dd.json", '"format"'),
    ]:
        result = core.save_document(VALID_CSV, name, root=tmp_path)
        assert marker in (tmp_path / name).read_text()
        assert result["format"] in {"csv", "linkml", "json"}

    # An unknown extension is a question, not a guess.
    with pytest.raises(ValueError, match="cannot infer a format"):
        core.save_document(VALID_CSV, "dd.txt", root=tmp_path)
    # Unless the caller says which format they meant.
    core.save_document(VALID_CSV, "dd.txt", root=tmp_path, to="csv")
    assert (tmp_path / "dd.txt").read_text().startswith("Id,")


def test_save_is_disabled_unless_a_root_is_configured(tmp_path):
    with pytest.raises(ValueError, match="saving is not enabled"):
        core.save_document(VALID_CSV, str(tmp_path / "dd.csv"), root=None)


def test_save_refuses_to_escape_the_root(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.csv"

    for escape in ["../outside.csv", "a/../../outside.csv", str(outside)]:
        with pytest.raises(ValueError, match="refusing to save outside"):
            core.save_document(VALID_CSV, escape, root=root)
    assert not outside.exists()

    # A symlink pointing out of the root is caught too — the check resolves the
    # path rather than trusting the string the caller sent.
    link = root / "link.csv"
    link.symlink_to(outside)
    with pytest.raises(ValueError, match="refusing to save outside"):
        core.save_document(VALID_CSV, str(link), root=root)
    assert not outside.exists()


def test_save_refuses_a_clobber_when_the_file_changed(tmp_path):
    out = tmp_path / "dd.csv"
    first = core.save_document(VALID_CSV, str(out), root=tmp_path)

    # Someone else edits the file (a human in dd-edit, say).
    out.write_text("Id,Label,Datatype,Cardinality\nedited,Edited,string,single\n")

    with pytest.raises(ValueError, match="changed on disk"):
        core.save_document(
            VALID_CSV, str(out), root=tmp_path, expect_sha256=first["sha256"]
        )
    assert "edited" in out.read_text()  # their edit survived

    # The digest of what is actually there lets the save through.
    current = hashlib.sha256(out.read_bytes()).hexdigest()
    result = core.save_document(
        VALID_CSV, str(out), root=tmp_path, expect_sha256=current
    )
    assert result["existed"] is True
    assert "edited" not in out.read_text()


def test_save_guards_against_a_pointless_digest_and_honours_overwrite(tmp_path):
    out = tmp_path / "dd.csv"
    # A digest for a file that does not exist is a caller mistake, not a no-op.
    with pytest.raises(ValueError, match="does not exist"):
        core.save_document(VALID_CSV, str(out), root=tmp_path, expect_sha256="a" * 64)

    core.save_document(VALID_CSV, str(out), root=tmp_path)
    with pytest.raises(ValueError, match="overwrite is false"):
        core.save_document(VALID_CSV, str(out), root=tmp_path, overwrite=False)


@pytest.mark.asyncio
async def test_save_over_mcp_is_off_by_default_and_bounded_when_on(tmp_path):
    async with connect() as client:
        assert "save_dictionary" in {
            t.name for t in (await client.list_tools()).tools
        }

        # Default: no save root, so the tool exists but refuses.
        res = await client.call_tool(
            "save_dictionary", {"content": VALID_CSV, "path": "dd.csv"})
        assert "saving is not enabled" in res.content[0].text

        server.SAVE_ROOT = tmp_path
        try:
            res = await client.call_tool(
                "save_dictionary", {"content": VALID_CSV, "path": "dd.csv"})
            payload = json.loads(res.content[0].text)
            assert payload["elementCount"] == 2
            assert (tmp_path / "dd.csv").exists()

            # A session saves without the document crossing the wire.
            opened = json.loads((await client.call_tool(
                "open_dictionary", {"content": VALID_CSV})).content[0].text)
            res = await client.call_tool("save_dictionary", {
                "session_id": opened["sessionId"], "path": "from_session.yaml",
            })
            payload = json.loads(res.content[0].text)
            assert payload["format"] == "linkml"
            assert "classes:" in (tmp_path / "from_session.yaml").read_text()
        finally:
            server.SAVE_ROOT = None


def test_configure_gates_saving_on_the_flag(tmp_path, monkeypatch):
    """The --save-root flag is the security boundary, so pin it rather than
    trust a hand-run --help."""
    monkeypatch.setattr(server, "SAVE_ROOT", None)

    # No flag: saving stays off, and the tool says so rather than writing.
    assert server.configure([]) is None
    with pytest.raises(ValueError, match="saving is not enabled"):
        server.save_dictionary(path=str(tmp_path / "dd.csv"), content=VALID_CSV)

    # With the flag: the root is resolved (so a relative or ~ path is absolute
    # by the time anything is checked against it) and saving works.
    assert server.configure(["--save-root", str(tmp_path)]) == tmp_path.resolve()
    assert server.SAVE_ROOT == tmp_path.resolve()
    result = server.save_dictionary(path="dd.csv", content=VALID_CSV)
    assert (tmp_path / "dd.csv").exists()
    assert result["elementCount"] == 2

    # ...and the containment check is live over the configured root.
    with pytest.raises(ValueError, match="refusing to save outside"):
        server.save_dictionary(path="../escaped.csv", content=VALID_CSV)


def test_configure_rejects_a_save_root_that_is_not_a_directory(tmp_path, monkeypatch):
    monkeypatch.setattr(server, "SAVE_ROOT", None)
    a_file = tmp_path / "not_a_dir"
    a_file.write_text("")

    # argparse.error exits rather than raising, which is what an operator should
    # get on a mistyped path: a failed start, not a server that cannot save.
    for bad in [str(a_file), str(tmp_path / "nonexistent")]:
        with pytest.raises(SystemExit):
            server.configure(["--save-root", bad])
    assert server.SAVE_ROOT is None
