# SSH host file access: SFTP vs per-command ssh (#886)

`SshHost.fs` serves artifact pickup and ACP `fs/*` over one persistent SFTP session per host.
Before 0.7.1 every call was its own `ssh` process (`cat`, `test -e`, `mkdir -p`); that path is
still there as the fallback and as `SshHost.execFs`, which is what this benchmark compares
against.

## How it is measured

`tools/benchmarks/ssh-host-fs/run.js` runs four scenarios against one host, three cold repeats
each (the SFTP session is closed before every repeat, so its handshake is in the time):

- write 100 small (~1 KB) files at once, and one 50 MB file;
- pick up the same: one batched existence check, then every file read at once, which is what
  `agent-step` does when an agent finishes.

`.github/workflows/ssh-host-fs-bench.yml` runs it on a GitHub-hosted runner against a throwaway
sshd on loopback, once as is and once with 20 ms of round-trip latency added to loopback to
stand in for a host on another network. It runs on pull requests that touch the SSH host code
and on demand.

## Results

Pending the first CI run.
