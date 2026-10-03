# Persistence evidence record

Use `passed`, `failed`, `blocked` or `unrun` for each row. Keep failed attempts when a later
attempt succeeds. “Passed” refers to the named workload/oracle only.

| Identity / environment | Observation |
| --- | --- |
| Source class | Current main / approved frozen candidate / historical only |
| Exact commit and tree | Full SHA values, never a mutable branch alone |
| Approved runtime source / current diff | SHA/tree, ownership check, later authorized rebases |
| Compiled artifacts | Manifest path and SHA-256; build command, exit, tool versions |
| Harness | File hashes and revision |
| Host | Node executable/version, OS/kernel/arch, CPU, memory, filesystem/mount and backing evidence |
| Dataset | Profile, seed, all dimensions, random cryptographic identifiers acknowledged |
| Limits | Suite/child time, setup time, RSS, disk/files/logs and observed stops |
| Cache | Process-cold or warm; OS-cache protocol or blocked; append warmup separately |
| Order | Exact sequence of cases/candidates and repetitions |

| Check | Status | Oracle, observation, evidence path, limitation |
| --- | --- | --- |
| Harness self-checks | unrun | Counts, interval union, fixture reuse rejection, resource guards |
| Compiled build | unrun | Exit, SHA inventory |
| Setup | unrun | Per-case dimensions and result |
| Each scaling case × cache × filesystem | unrun | All samples, count, median, min/max/spread |
| Combined case | unrun | Same as above; no sum of overlapping intervals |
| Scripted-agent compiled demo | unrun | Each exit and wall time |
| Physical disk with unchanged durability | blocked | Backing/hardware evidence required |
| Storage-cold | blocked | Approved OS-cache protocol required |
| Private phase attribution | blocked | Name missing counters; proposed seam, no invented figures |
| Frozen candidate comparison | unrun | Exact approved source and artifact identity required |
| Cleanup | unrun | Owned scratch removed; keys/private state excluded from packet |
| Optimization/security/package acceptance | unrun | Separate from this baseline |

Explain candidate bottlenecks using the measured scaling axis and public operation counts,
then give confidence limits and alternative explanations. Reference #408 for optimization
and attribution work; inventory existing work before creating any new issue. Document
which parent criteria remain unmet. Do not infer a performance budget from historical
55.7% acceptance, a single host or three noisy samples.
