- **cli:** Safely render malformed event and plan journal display fields without object
  stringification. Legacy gate labels, structured journal JSON and stored events are preserved.
- **app:** Keep malformed structured-form scalar values blank instead of coercing objects or
  arrays, and display launch Request identifiers only when they are strings.
