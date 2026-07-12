"""PyInstaller entry point — equivalent to ``python -m dd_edit_sidecar``.

PyInstaller bundles a script, not a module invocation, so this thin file
gives it one. Everything real lives in dd_edit_sidecar.__main__.
"""

from dd_edit_sidecar.__main__ import main

if __name__ == "__main__":
    raise SystemExit(main())
