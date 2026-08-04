"""Server-held documents: phase 2 of docs/MCP-DESIGN.md.

Phase 1 is pure — every tool takes a document and returns a new one, and the
caller (the LLM's context) carries it between calls. That costs tokens on every
edit and, worse, gives the model a chance to paraphrase or drop a field each time
it re-emits the document. See "When to go stateful" in the design doc.

This module adds the missing piece and nothing else: a store holding one
authoritative copy of a document under a handle, so a sequence of edits mutates
that copy instead of round-tripping through the conversation.

Deliberately thin. The operations still live in core as pure functions; a session
edit is "load the held text, call the same core function, keep the result". So
there is exactly one implementation of what an edit *means*, and the stateless
path stays available for one-shot work, where it is still the better mode.

Phase 3 replaces what a Session holds — the document open in a running dd-edit
instance rather than a string in this process — without changing the tools that
sit on top. That is why the store is an object with a small interface rather than
a module-level dict.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import count
from typing import Callable

from dd_edit_mcp.core import EditResult, describe_dictionary


@dataclass
class Session:
    """One held document, plus the findings from the last operation on it.

    `document` is dd-json text, the same form every core function accepts, so a
    session holds nothing the stateless path could not also produce. `revision`
    counts applied edits: it gives a caller a cheap way to notice that a document
    changed under it, which phase 3 needs when a human is editing the same
    document concurrently.
    """

    id: str
    document: str
    revision: int = 0
    findings: list = field(default_factory=list)

    def summary(self) -> dict:
        """What a caller needs to know about this session without shipping it.

        The whole point of a session is not sending the document, so every
        session-mode tool returns this instead: enough to see what happened
        (element count, validity, how many errors) and nothing that scales with
        the size of the dictionary.
        """
        described = describe_dictionary(self.document)
        return {
            "sessionId": self.id,
            "revision": self.revision,
            "elementCount": described["elementCount"],
            "valid": described["valid"],
            "errorCount": described["errorCount"],
            "warningCount": described["warningCount"],
        }


class SessionStore:
    """Holds open documents by handle.

    In-memory and process-scoped: sessions live as long as the server does, which
    for a stdio server is one client conversation. There is deliberately no
    expiry — a document a client is editing must not evaporate mid-conversation,
    and an idle-timeout policy is only meaningful for a long-lived shared server,
    which this is not yet. `close` is the one way a session ends.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._ids = count(1)

    def open(self, document: str, findings: list | None = None) -> Session:
        """Take a document under management and return its session."""
        session_id = f"s{next(self._ids)}"
        session = Session(
            id=session_id, document=document, findings=list(findings or [])
        )
        self._sessions[session_id] = session
        return session

    def get(self, session_id: str) -> Session:
        """Look up a session, or explain what went wrong.

        A stale handle is the failure a caller will actually hit — reusing an id
        from a closed session, or from a previous server process — so the message
        says which sessions *are* open rather than only that this one is not.
        """
        session = self._sessions.get(session_id)
        if session is None:
            known = ", ".join(sorted(self._sessions)) or "none"
            raise ValueError(
                f"no open session {session_id!r} (open sessions: {known}); "
                f"a session ends when it is closed or the server restarts"
            )
        return session

    def close(self, session_id: str) -> Session:
        """Release a session. Returns it, so the caller can save the document."""
        session = self.get(session_id)
        del self._sessions[session_id]
        return session

    def list(self) -> list[dict]:
        """Summaries of every open session, oldest first."""
        return [s.summary() for s in self._sessions.values()]

    def apply(
        self, session_id: str, operation: Callable[[str], EditResult]
    ) -> Session:
        """Run a core editing function against a held document and keep the result.

        `operation` takes the current document text and returns an EditResult —
        i.e. exactly the signature of every editing function in core, with its
        other arguments already bound. That is the whole adapter between the pure
        layer and this one.

        The held document is replaced only if the operation succeeds: a rejected
        edit (an unknown datatype, an ambiguous id) leaves the session exactly as
        it was, so a caller can retry without having corrupted anything. The
        exception propagates unchanged.
        """
        session = self.get(session_id)
        result = operation(session.document)
        session.document = result.document
        session.findings = result.findings
        session.revision += 1
        return session
