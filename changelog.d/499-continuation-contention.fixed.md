- **daemon:** A competing continuation reconciliation refused with `RUN_LEASED`
  preserves the winning receipt, including before execution lease acquisition.
  Retained-key replay no longer publishes a transient blocked state; the winning
  continuation still records one decision, attachment, execution and settlement.
