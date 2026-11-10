- **app:** Releasing a claim on the Agents surface no longer drops keyboard focus on the page.
  When the release goes through and the claim leaves the list, focus moves to the next row's
  **Release**, to the previous row's if it was the last row, or to the "Claimed work" section
  if the list is now empty. Focus moved elsewhere while the release was in flight stays where
  it was put, and a refused release keeps its row and its focus. The result, which used to
  vanish with the row, is shown under the section's heading.
