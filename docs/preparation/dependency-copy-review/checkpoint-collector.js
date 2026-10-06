// Generic supported MCP checkpoint handoff. No automatic invocation.
// Real binding-file path/hash are private caller arguments, never embedded here.
async function collectCheckpoint(bindingFile, bindingSha256, tools, report = () => {}) {
function quote(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
if(!/^[0-9a-f]{64}$/.test(bindingSha256)) throw new Error("Invalid binding hash");
const bindingProgram = [
 "import os,stat,json,hashlib,pathlib",
 "p=pathlib.Path("+JSON.stringify(bindingFile)+")",
 "assert p.is_absolute() and not any(x.is_symlink() for x in [p,*p.parents])",
 "fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)",
 "st=os.fstat(fd)",
 "assert stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_uid==os.geteuid() and stat.S_IMODE(st.st_mode)==0o600",
 "b=os.fdopen(fd,'rb').read()",
 "assert hashlib.sha256(b).hexdigest()=="+JSON.stringify(bindingSha256),
 "print(json.dumps({'stage':json.loads(b)['stage']}))"
].join("; ");
const bindingRead = await tools.exec_command({cmd:"python3 -I -S -B -c "+quote(bindingProgram),max_output_tokens:1000});
if(bindingRead.exit_code!==0) throw new Error("Private binding validation refused");
const stage = JSON.parse(bindingRead.output).stage;
function q(s) { return "'" + s.replace(/'/g, "'\\''") + "'"; }
const readProgram = "import pathlib,json,os,stat; s=pathlib.Path("+JSON.stringify(stage)+"); p=s/'gate-request.json'; st=p.lstat(); assert stat.S_ISREG(st.st_mode) and st.st_uid==os.geteuid() and stat.S_IMODE(st.st_mode)==0o600; assert not (s/'gate-response.json').exists() and not (s/'gate-response.pending.json').exists(); print(p.read_text())";
const rr = await tools.exec_command({cmd:"python3 -I -S -B -c "+q(readProgram),max_output_tokens:2000});
if (rr.exit_code !== 0) throw new Error("No usable approved execution checkpoint");
const request = JSON.parse(rr.output);
const discoveryResult = await tools.mcp__codex_apps__orca_tunnel_test_discover_orca({});
if(discoveryResult.isError) throw new Error("Discovery denied");
const discovery = discoveryResult.structuredContent;
if(discovery.target.workspaceId!==request.target.workspaceId || discovery.target.instanceId!==request.target.instanceId) throw new Error("Deployment drift");
const args = {target:request.target,runId:request.runId,limit:20};
const results = await Promise.allSettled([
 tools.mcp__codex_apps__orca_tunnel_test_list_runs(args),
 tools.mcp__codex_apps__orca_tunnel_test_list_steps(args),
 tools.mcp__codex_apps__orca_tunnel_test_list_approvals(args)
]);
for(const result of results) {
 if(result.status!=="fulfilled" || result.value.isError) throw new Error("Checkpoint read unavailable");
 const page=result.value.structuredContent;
 if(page.truncated || page.restartRequired || page.nextCursor) throw new Error("Incomplete checkpoint");
}
const response = {nonce:request.nonce,discovery,runs:results[0].value.structuredContent,
 steps:results[1].value.structuredContent,approvals:results[2].value.structuredContent};
await tools.apply_patch("*** Begin Patch\n*** Add File: "+stage+"/gate-response.pending.json\n+"+JSON.stringify(response)+"\n*** End Patch");
const publishProgram = [
 "import os,pathlib,ctypes,errno,stat",
 "s=pathlib.Path("+JSON.stringify(stage)+")",
 "p=s/'gate-response.pending.json'",
 "assert p.lstat().st_uid==os.geteuid() and stat.S_ISREG(p.lstat().st_mode)",
 "os.chmod(p,0o600)",
 "fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)",
 "os.fsync(fd)",
 "os.close(fd)",
 "lib=ctypes.CDLL(None,use_errno=True)",
 "rename=lib.renameat2",
 "rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]",
 "rename.restype=ctypes.c_int",
 "result=rename(-100,os.fsencode(p),-100,os.fsencode(s/'gate-response.json'),1)",
 "assert result==0, os.strerror(ctypes.get_errno())",
 "fd=os.open(s,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)",
 "os.fsync(fd)",
 "os.close(fd)"
].join("; ");
const published = await tools.exec_command({cmd:"python3 -I -S -B -c "+q(publishProgram),max_output_tokens:1000});
if(published.exit_code!==0) throw new Error("Checkpoint publication refused; preserve partial evidence");
report({privateCheckpointPublished:true,copyResultStillRequiresSeparateInspection:true});

}

