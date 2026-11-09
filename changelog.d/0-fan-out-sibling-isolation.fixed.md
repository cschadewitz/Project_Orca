- **engine:** A `parallel` branch or `custom:plan-dispatch` item that starts after another
  has finished no longer sees that sibling's artifacts, and neither do sequential siblings
  bound to different work items. A program dispatching two items at a time no longer hands
  the third item an earlier item's `testReport` and `review` as feedback for its first build.
