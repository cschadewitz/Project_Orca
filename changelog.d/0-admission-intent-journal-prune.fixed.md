- **app:** Starting runs from the palette or guided launch no longer stops working after
  about 1,000 runs. The encrypted run-intent journal now drops abandoned intents when it
  next writes, including ones an earlier version left behind, and its 1,000 limit counts
  only retained intents, which are never pruned. At that limit the refusal says too many
  intents are retained instead of pointing at the OS keychain.
