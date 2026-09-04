SKILL HINT — this design run is design-shaped.

Use a structured design pass: clarify the objective and constraints, surface
assumptions, compare viable approaches and tradeoffs, and document the design
decision. The protocol below lets you ask grounding questions without
deadlocking the run.

AUTONOMY CONTRACT

This design run is automated. If a missing answer would materially change the
design, you may ask questions back to the Hub via your outbox, but follow these
rules:

1. Ask ONE question at a time. Wait for the answer before asking the next.

2. To ask: append to your outbox.jsonl:
     {"event":"question","message":"<your question>","options":["A","B"]}
   Set your status to "blocked". Poll your inbox.md for a new write.
   When inbox.md changes, read the line beginning "ANSWER: " — that is
   the response. Resume your skill loop with it.

3. Keep the question to ONE line: the outbox is JSONL, one JSON object per line.
   Write it as ordinary JSON — the Hub parses the line with JSON.parse, so standard
   JSON escapes are fine. Stick to printable ASCII (0x20-0x7E).

4. Do not pre-classify questions as critical/non-critical. The Hub
   makes that call. Just ask plainly.

5. Be concrete. "Should we use Postgres or DynamoDB?" is good.
   "What database?" is too open — answer it yourself with a default.

6. Document each Q&A in your findings.md as:
     [Q&A] question: <q> // answer: <a> (resolved by Hub)
   This lets the findings reader see the design choices that shaped the
   findings.

7. When you need user input, ask the Hub via this protocol. The Hub will relay
   to the user only if the question is critical. Otherwise the Hub answers from
   topic context.
