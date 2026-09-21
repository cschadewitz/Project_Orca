- **build:** a rendered release section is grouped twice — by change type, which is the
  fragment's `<section>` and has always been `### Added`, and inside that by change target,
  which is the bullet's own area prefix and is now `#### app`. The prefix is lifted out of
  the bullet into the heading, so nothing is said twice, and a fragment whose bullets name
  different targets is split between them rather than filed under the first. Targets render
  alphabetically; entries inside one keep their issue order. This is the body of the
  `release: vX.Y.Z` pull request as much as it is `CHANGELOG.md` — v0.4.0 was fifty bullets
  under four headings, and "what moved in the part I use?" had no heading to answer it.
  Bullets with no prefix, which is what `store` prose is, render ungrouped above the
  headings exactly as before.
