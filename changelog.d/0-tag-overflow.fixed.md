- **app:** An agent card with many roles wraps them inside the card instead of running them
  past its edge and under the card beside it. The card's name no longer breaks at a hyphen
  ("scripted-" over "slow"): it keeps one line and the host label gives way, truncating at
  its end with the whole value in its title. The same fix covers the other places a row of
  labels could outgrow its box: the workflow inspector's kind and attempt chips wrap, a
  request id filter on the Plan rail truncates at its end instead of running past the rail,
  and the titles of the step, run and workflow-editor inspectors, the editor's node list and
  the permission panel's agent id stay on one line, cut at the end with the full text in
  their titles. A run of chips is one class in the component layer, `.orca-chips`, rather
  than a copy per surface.
