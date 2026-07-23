"""dd-edit MCP server (phase-1 spike).

Exposes data-dictionary capabilities to an MCP client over stdio. This spike
ships a single tool, validate_dictionary, to prove the toolkit runs outside
FastAPI and that the MCP plumbing works end to end. See docs/MCP-DESIGN.md for
the full planned tool inventory.

Run:  python -m dd_edit_mcp.server      (stdio; wire into an MCP client)
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from dd_edit_mcp import core

mcp = FastMCP("dd-edit")


@mcp.tool()
def validate_dictionary(content: str) -> dict:
    """Validate a RADx data dictionary and return findings.

    Accepts a data dictionary in any of the toolkit's formats — dd-json,
    LinkML YAML, or the data-dictionary CSV — auto-detected from the content.
    Returns validation findings (errors and warnings) such as duplicate ids,
    unknown datatypes, missing units, or malformed enumerations. A valid
    document returns an empty findings list.

    Findings never raise: a well-formed but invalid document (e.g. a duplicate
    id) comes back as findings, not an error. Only input the parser cannot load
    at all raises.

    Args:
        content: The data dictionary text (dd-json, LinkML YAML, or CSV).

    Returns:
        A dict with:
          - detected: the format that was detected ("json" | "linkml" | "csv")
          - valid: true if there are no ERROR-level findings
          - findings: list of {level, check, message, line, column, value,
            elementIndex, elementId, suggestion}
    """
    findings = core.validate_document(content)
    return {
        "detected": core.detect(content),
        "valid": not any(f.level == "ERROR" for f in findings),
        "findings": [f.as_dict() for f in findings],
    }


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
