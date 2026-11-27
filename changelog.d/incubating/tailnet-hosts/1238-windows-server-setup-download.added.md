- **deploy:** The Windows server setup fetches the release's own Windows server bundle when no
  bundle is carried to it: only once the release records all three files, each download checked
  against that record before the signature check that always follows (#1238).
