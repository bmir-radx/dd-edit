"""End-to-end tests for the sidecar over FastAPI's TestClient."""

from __future__ import annotations

import csv
import io
import json

import pytest
from fastapi.testclient import TestClient

from dd_edit_sidecar import app

DD_CSV = (
    "Id,Label,Datatype,Cardinality,Enumeration,Unit\n"
    'age,Age,integer,single,,years\n'
    'sex,Sex at birth,integer,single,"""1""=[Male] | ""2""=[Female]",\n'
)

REDCAP_CSV = (
    'Variable / Field Name,Form Name,Section Header,Field Type,Field Label,'
    '"Choices, Calculations, OR Slider Labels",Field Note,'
    'Text Validation Type OR Show Slider Number,Text Validation Min,'
    'Text Validation Max,Identifier?,Branching Logic (Show field only if...),'
    'Required Field?,Custom Alignment,Question Number (surveys only),'
    'Matrix Group Name,Matrix Ranking?,Field Annotation\n'
    'age,demo,,text,Age,,,integer,0,120,,,y,,,,,\n'
    'sex,demo,,radio,Sex at birth,"1, Male | 2, Female",,,,,,,y,,,,,\n'
)


@pytest.fixture()
def client():
    return TestClient(app)


def test_health_reports_toolkit_versions(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["versions"]["dd-api"] != "missing"


def test_meta_lists_datatypes(client):
    body = client.get("/meta").json()
    assert "integer" in body["datatypes"]
    assert body["cardinalities"] == ["single", "multiple"]


def test_convert_csv_to_json_and_back(client):
    r = client.post("/convert", json={"content": DD_CSV, "to": "json"})
    assert r.status_code == 200, r.text
    doc = json.loads(r.json()["content"])
    assert doc["format"] == "dd-json"
    assert [e["id"] for e in doc["elements"]] == ["age", "sex"]

    back = client.post("/convert", json={"content": r.json()["content"], "to": "csv"})
    assert back.status_code == 200
    rows = list(csv.DictReader(io.StringIO(back.json()["content"])))
    assert rows[1]["Enumeration"] == '"1"=[Male] | "2"=[Female]'


def test_convert_to_linkml(client):
    r = client.post("/convert", json={"content": DD_CSV, "to": "linkml"})
    assert r.status_code == 200
    assert "classes" in r.json()["content"]


def test_convert_rejects_malformed_input(client):
    r = client.post("/convert", json={"content": "not,a\ndictionary", "to": "json"})
    assert r.status_code == 422


def test_validate_returns_findings_not_errors(client):
    bad = "Id,Label,Datatype,Cardinality\nage,Age,notatype,single\n"
    r = client.post("/validate", json={"content": bad})
    assert r.status_code == 200
    findings = r.json()["findings"]
    assert any("datatype" in f["check"].lower() or "datatype" in f["message"].lower()
               for f in findings)


def test_render_produces_html(client):
    r = client.post("/render", json={"content": DD_CSV, "title": "Test"})
    assert r.status_code == 200
    assert "<html" in r.json()["html"].lower()


def test_import_redcap(client):
    r = client.post("/import/redcap", json={"content": REDCAP_CSV})
    assert r.status_code == 200, r.text
    assert r.json()["elements"] == 2
    doc = json.loads(r.json()["content"])
    ids = [e["id"] for e in doc["elements"]]
    assert ids == ["age", "sex"]


def test_import_redcap_rejects_non_redcap(client):
    r = client.post("/import/redcap", json={"content": DD_CSV})
    assert r.status_code == 422


def test_token_enforced_when_set(client, monkeypatch):
    monkeypatch.setenv("DD_EDIT_TOKEN", "sekrit")
    assert client.get("/meta").status_code == 401
    assert client.get("/health").status_code == 200  # exempt
    ok = client.get("/meta", headers={"Authorization": "Bearer sekrit"})
    assert ok.status_code == 200
