- **app:** Add explicit same-boot orphan reconciliation for new, kernel-fenced
  first-run generations, distinguish surviving owned and unknown writers, and
  recover interrupted saved-configuration binding after verified quiescence.
  Preserve retained evidence/work and require explicit continuation after recovery;
  legacy unfenced attempts and native acceptance remain separate gates.
