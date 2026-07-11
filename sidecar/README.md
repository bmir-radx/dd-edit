# dd-edit sidecar

The Python half of [dd-edit](../DESIGN.md): a stateless FastAPI service that
wraps the [data dictionary toolkit](https://github.com/bmir-radx/radx-data-dictionary-specification)
(`dd-api`, `dd-validate`, `dd-printer`, `dd-redcap`, pinned to a released tag).
The Electron app spawns it on a random localhost port and talks dd-json to it;
it holds no state between requests.

## Endpoints

`GET /health` · `GET /meta` · `POST /convert` · `POST /validate` ·
`POST /render` · `POST /import/redcap` — see [DESIGN.md](../DESIGN.md) for the
contract.

## Development

```sh
cd sidecar
python -m venv .venv && source .venv/bin/activate
pip install -e ".[test]"
pytest                                  # run the endpoint tests
python -m dd_edit_sidecar --port 8756   # run it (no auth unless DD_EDIT_TOKEN is set)
```
