#!/bin/sh
# Build the sidecar as a PyInstaller one-dir bundle at sidecar/dist/dd-edit-sidecar.
# Run from anywhere; requires the sidecar venv with the build extra installed:
#   cd sidecar && .venv/bin/pip install -e ".[build]"
#
# --collect-data pulls in the non-Python files PyInstaller can't see:
#   dd_core        grammar/*.lark          (enumeration & precondition parsers)
#   dd_printer     templates/ + static/    (HTML rendering)
#   prefixcommons  registry/*.jsonld       (linkml-runtime transitive dep)
#   prefixmaps     data registry           (linkml-runtime transitive dep)
#   linkml_runtime linkml_model data       (schema emission)
#   lark           grammar analysis data
# --copy-metadata keeps importlib.metadata.version() working: /health reports
# the dd-* versions, and prefixmaps/linkml-runtime read their own at import.
set -e
cd "$(dirname "$0")"
.venv/bin/pyinstaller --noconfirm --onedir \
  --name dd-edit-sidecar \
  --distpath dist --workpath build/pyinstaller --specpath build \
  --collect-data dd_core \
  --collect-data dd_printer \
  --collect-data prefixcommons \
  --collect-data prefixmaps \
  --collect-data linkml_runtime \
  --collect-data lark \
  --copy-metadata dd-api --copy-metadata dd-core --copy-metadata dd-linkml \
  --copy-metadata dd-printer --copy-metadata dd-redcap --copy-metadata dd-validate \
  --copy-metadata prefixmaps --copy-metadata linkml-runtime \
  pyinstaller_entry.py
