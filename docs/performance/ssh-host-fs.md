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

Recorded on [run 45004839217](https://github.com/cschadewitz/Project_Orca/actions/runs/45004839217)
(commit `831d473`): GitHub-hosted `ubuntu-24.04`, Xeon Platinum 8370C, Node 24.22.3, OpenSSH
on loopback. Medians of three cold runs, in milliseconds.

| Network | Scenario | per-command ssh | SFTP | Speed-up |
| --- | --- | ---: | ---: | ---: |
| loopback | pick up 100 small files | 5301 | 208 | 25.5× |
| loopback | pick up one 50 MB file | 650 | 523 | 1.2× |
| loopback | write 100 small files | 5133 | 212 | 24.2× |
| loopback | write one 50 MB file | 413 | 499 | 0.8× |
| 20 ms RTT | pick up 100 small files | 5690 | 597 | 9.5× |
| 20 ms RTT | pick up one 50 MB file | 1564 | 1253 | 1.2× |
| 20 ms RTT | write 100 small files | 5336 | 554 | 9.6× |
| 20 ms RTT | write one 50 MB file | 1121 | 1205 | 0.9× |

Reading it:

- Many small files is where the old path hurt: each file was a full ssh handshake (about
  50 ms of CPU-bound key exchange each, even on loopback), and 100 of them at once queue on
  sshd. One session with every request pipelined removes all but one handshake.
- One large file is a single stream either way. Pickup is still faster over SFTP because the
  64-request read window keeps the pipe full. A single large *write* is within 10–20% of
  `cat > file`: the per-command path is one unframed stream, while SFTP frames and
  acknowledges every 32 KiB chunk. Writes are not on the pickup path and stay at the same
  order of magnitude. Removing two buffer copies per WRITE packet (the next commit) did not
  move the ratio: on [run 45005232465](https://github.com/cschadewitz/Project_Orca/actions/runs/45005232465)
  (an EPYC 7763 runner) a 50 MB write was 476 ms per-command and 574 ms over SFTP on loopback, and
  1114 ms and 1227 ms at 20 ms RTT, while the small-file and pickup ratios held (22×, 9.5×).
