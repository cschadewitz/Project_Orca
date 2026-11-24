#!/usr/bin/env bash
# Puts the pinned GitHub CLI ($GH_VERSION, default 2.102.0) first on the job's PATH, for
# check-support-matrix.js. Older releases matched `gh attestation verify --signer-workflow` as a
# prefix (GHSA-wjmr-j3rp-mh2g), and the checker refuses them. The release's linux-amd64 build is
# fetched and checked against the release's published SHA-256 sums.
#
# Then a compatibility check with a real attestation, so a verifier that changes shape is caught
# even while no row is promoted: the gh tarball's own build provenance, attested by cli/cli, must
# verify and must carry every certificate field attestation.js reads.
# GitHub Actions only (writes $GITHUB_PATH; needs GH_TOKEN).
set -euo pipefail
want="${GH_VERSION:-2.102.0}"
d="${RUNNER_TEMP:?}/gh-$want"
mkdir -p "$d"
cd "$d"
base="https://github.com/cli/cli/releases/download/v${want}"
tarball="gh_${want}_linux_amd64.tar.gz"
curl -fsSLO "$base/$tarball"
curl -fsSLO "$base/gh_${want}_checksums.txt"
grep " ${tarball}\$" "gh_${want}_checksums.txt" | sha256sum -c -
tar -xzf "$tarball"
gh="$d/gh_${want}_linux_amd64/bin/gh"
"$gh" --version
echo "$d/gh_${want}_linux_amd64/bin" >> "$GITHUB_PATH"

"$gh" attestation verify "$tarball" --repo cli/cli --deny-self-hosted-runners --format json > verified.json
node -e '
  const results = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const fields = ["sourceRepositoryDigest", "sourceRepositoryRef", "runnerEnvironment", "buildSignerURI", "buildSignerDigest"];
  const cert = results?.[0]?.verificationResult?.signature?.certificate ?? {};
  const missing = fields.filter((f) => typeof cert[f] !== "string" || cert[f] === "");
  if (missing.length) throw new Error(`gh verify output lacks ${missing.join(", ")}`);
  console.log("gh attestation verify output carries every field the checker reads");
' verified.json
