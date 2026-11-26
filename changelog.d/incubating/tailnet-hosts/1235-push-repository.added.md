- **cli:** `orca-cli remote push-repo <host>` puts this repository on a server that `remote add`
  set up (#1235). The current branch, or each `--ref`, is copied as a git bundle over the pinned
  host key, and the host fetches it into a bare repository under the server root. A checkout
  beside it has that repository as `origin`. The host needs no git credentials. A branch is
  only moved forward, never overwritten. The command prints the `workspace:` settings for the
  server's config.
