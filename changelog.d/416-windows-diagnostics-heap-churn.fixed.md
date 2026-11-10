Reduce diagnostics heap churn by reusing report scheduling callbacks and a compact
event cursor, scanning the exact canonical event grammar, and reusing validated
preview text. Keep checkpoint bytes in their owned arena lease through disk
settlement. Preserve report/event limits, exact Save content, erasure and consent;
production capture remains disabled pending the separate acceptance gates.
