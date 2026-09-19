# Saved session and run logs

Selected ORCA event logs kept for reference: real-agent runs worth re-reading when a
template, a workflow or the ACP facade changes. Everything else stays in the live store
(`/srv/dev/orca-live/.orca*/runs/`) and is not committed.

One folder per save, named `<YYYY-MM-DD>-<what>`, each with:

- a `README.md` saying which session or run it is, what was prompted, how it ended, and
  anything the log shows that is worth knowing;
- the raw `run_<id>.jsonl` event logs, copied unchanged from the store's `runs/` directory
  (one JSON event per line, `seq`-ordered; see [DATA-MODEL.md](../DATA-MODEL.md) for the
  event types and [REAL-AGENT-TEST.md](../REAL-AGENT-TEST.md) §6 for what an agent session
  leaves in the log and what it does not).

Read a saved log the same way as a live one:

```bash
orca events <runId> --json          # from the live store, while the run is still there
node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n")) if (l) { const e = JSON.parse(l); if (e.type !== "agent.update") console.log(e.seq, e.at, e.type) }' docs/session-logs/<folder>/run_<id>.jsonl
```

Before saving a log, grep it for credentials: permission titles carry the full command text
the agent asked to run, and `agent.update` text is whatever the agent said.

| Folder | What |
| --- | --- |
| [2026-09-19-kepler-session-sess_01M2VHXARDM7Z6V5RTVVBE136M/](2026-09-19-kepler-session-sess_01M2VHXARDM7Z6V5RTVVBE136M/) | first successful Kepler-driven program run (#98 step 5): one request, one work item, `ai-sdlc` child to `deploy` |
