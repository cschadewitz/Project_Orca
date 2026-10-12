- **app:** Deleting from the workflow editor's inspector no longer drops keyboard focus on the
  page. After **Delete** or **Delete with its connections** the selection moves to the next node
  in file order (the previous one if it was the last), after **Delete edge** to the node the
  edge left from, and focus goes to the canvas, where `⌘Z` takes the delete back. The canvas's
  own Delete key moves the selection the same way. Focus moved elsewhere while the delete was
  out stays where it was put.
