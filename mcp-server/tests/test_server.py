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
