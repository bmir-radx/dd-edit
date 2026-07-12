"""Build the sidecar as a PyInstaller one-dir bundle at sidecar/dist/dd-edit-sidecar.

Run with the sidecar venv's Python (needs the build extra):

    cd sidecar && .venv/bin/pip install -e ".[build]"   # POSIX
    cd sidecar & .venv\\Scripts\\pip install -e ".[build]"  # Windows

or via `npm run build:sidecar`, which picks the right venv Python per OS.
Python (not shell) so the exact same build runs on macOS, Linux, and Windows.

--collect-data pulls in the non-Python files PyInstaller can't see:
  dd_core        grammar/*.lark          (enumeration & precondition parsers)
  dd_printer     templates/ + static/    (HTML rendering)
  prefixcommons  registry/*.jsonld       (linkml-runtime transitive dep)
  prefixmaps     data registry           (linkml-runtime transitive dep)
  linkml_runtime linkml_model data       (schema emission)
  lark           grammar analysis data
--copy-metadata keeps importlib.metadata.version() working: /health reports
the dd-* versions, and prefixmaps/linkml-runtime read their own at import.
"""

import os

import PyInstaller.__main__

os.chdir(os.path.dirname(os.path.abspath(__file__)))

PyInstaller.__main__.run([
    "--noconfirm",
    "--onedir",
    "--name", "dd-edit-sidecar",
    "--distpath", "dist",
    "--workpath", "build/pyinstaller",
    "--specpath", "build",
    "--collect-data", "dd_core",
    "--collect-data", "dd_printer",
    "--collect-data", "prefixcommons",
    "--collect-data", "prefixmaps",
    "--collect-data", "linkml_runtime",
    "--collect-data", "lark",
    "--copy-metadata", "dd-api",
    "--copy-metadata", "dd-core",
    "--copy-metadata", "dd-linkml",
    "--copy-metadata", "dd-printer",
    "--copy-metadata", "dd-redcap",
    "--copy-metadata", "dd-validate",
    "--copy-metadata", "prefixmaps",
    "--copy-metadata", "linkml-runtime",
    "pyinstaller_entry.py",
])
