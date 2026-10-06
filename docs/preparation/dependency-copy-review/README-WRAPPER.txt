Exact executable wrapper and synthetic checkpoint review

copy-once.py is the complete executable wrapper used by the private owner invocation.
There is no redacted/private variant. The published SHA256 must equal the local
wrapper bytes before execution. test_wrapper.py contains the same fifteen checkpoint
test cases with wholly synthetic in-memory deployment/run/gate values; it does not
read any real binding, private evidence, contract, provisioning record or run state.

Run the synthetic tests with the installed Python standard library:

    python3 -I -S -B test_wrapper.py

The tests import the adjacent exact wrapper without invoking main(). They call only
the pure validate_gate function and make no Git, copy, network or runtime operation.
wrapper-results.json records their execution profile and result. The previously
reviewed copier.py, relocation.py and their twenty-eight tests are unchanged.

Private binding interface

The wrapper CLI requires --binding-file and --binding-sha256. The binding must be an
absolute no-symlink, single-link regular file, mode0600 and owned by the current uid.
It is parsed only as JSON data after its bytes match the independently reviewed
SHA256 argument. No binding contents or hash are embedded in published wrapper code.
Stage/source/destination/control/helper paths, uid/inode identities, Git executable,
branches/HEAD/lock, receipt/ready hashes and content, inventory/proposal/contract/
helper hashes, counts, live baseline records and timing/headroom limits are local
data. The actual command packet, binding, contract and nonce evidence stay local.

Binding fields (data types shown; no operational values provided):
- stage:string; owner_uid:int; git_executable:absolute string
- source/destination:{path:string,dev:int,ino:int,uid:int}
- source_branch/destination_branch/source_git_dir/destination_git_dir/common_dir:
  strings; head/lock_blob:strings
- receipt/ready:{path:string,sha256:string,mode:string,content:JSON object}
- files:{absolute path:SHA256}; contract/copier/relocation/inventory/proposal:paths
- counts:{trees:int,entries:int,shims:int,prefixes:int,file_bytes:int}
- baseline:{discovery:object,runs:page,steps:page,approvals:page}, containing only
  previously authenticated deployment identity and original assigned run/gate data
- gate_max_age_seconds/checkpoint_timeout_seconds/minimum_free_bytes:positive numbers

The command reviewed privately pins BOTH executable-wrapper SHA256 and binding SHA256.
It runs in a clean environment with NODE_PATH absent, compile cache disabled, Python
isolated/no-site/no-bytecode mode, disabled global/system Git config and a bounded
timeout. Real arguments and tool/executable paths are in that local packet only.
Data-only binding does not imply safe authorization of arbitrary helper code: owners
must review its helper path/hash pins against the already approved immutable copier.

Mode and ownership requirements

--validate-only rechecks current source/provisioning/Git/copy preconditions and a
fresh owner-provided review snapshot; it never calls copy_exclusive or creates an
execution attempt, nonce request, destination access probe or dependency outputs.
--execute-once additionally requires --owner-holds-roots-and-gate. The owner must
actually hold exclusive control of both roots and other gate answers/continuations
throughout execution. The flag is an acknowledgement, not a runtime lock.

Execution creates an exclusive attempt record; partial output is never resumed,
deleted or replaced. Permission failure, drift, unsupported checkpoint or timeout
stops and retains local journals/outputs. No sandbox/credential/config/service/run
changes, package manager, installs, builds, project tests or agent start are present.

Authenticated checkpoint protocol

After read-only preflight, execution writes one nonce request and waits within the
binding's bounded checkpoint deadline. collectCheckpoint(bindingFile,bindingSha256,
tools,report) in checkpoint-collector.js uses the existing supported authenticated
MCP tools to discover identity and read that exact run, steps and pending inputs.
The collector is generic complete executable code; it is not invoked automatically.
It uses Python from the caller's reviewed clean PATH for private file handling.
It atomically publishes a mode0600 response without replacing existing evidence.
No token retrieval, raw protected-state access, alternate identity or bootstrap.

The wrapper checks the matching nonce, post-request/fresh/grouped timestamps,
complete pages, exact original identity/scope/run/step/pending gate records and
waiting state. This is trusted local owner-supplied evidence from authenticated
reads, not an independent shell authentication or cryptographic attestation. Missing
or stale evidence refuses copying; recorded review evidence cannot answer a fresh
random execution checkpoint. Owner hold remains a required concurrency precondition.

After fresh evidence, the wrapper rechecks bindings, probes only the assigned root,
rechecks freshness and calls the pinned copier once. Successful copying still leaves
independent destination/source verification and destination-local readiness pending.
Gate answering, coding-agent start, services and additional admissions are absent.
Owner-session results do not establish future worker sandbox, loopback or capacity.

Publication is preparation for independent code review, not permission to execute.
