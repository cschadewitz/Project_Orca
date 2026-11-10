New inactive standing-grant writes use rule version 2 with `expiresAt: null`,
and protected standing approvals use versions 2 or 3. Readers must support these
encodings; older binaries may refuse affected typed sidecars or scoped-grant
material after a downgrade. Existing finite grants are neither migrated nor
extended. Preserve the matching protected approvals and key material; rewriting an
until-revoked grant as a legacy finite grant is not a compatibility mechanism.
