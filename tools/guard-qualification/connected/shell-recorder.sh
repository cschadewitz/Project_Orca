#!/bin/sh
# The #706 connected proof's shell recorder, set as CLAUDE_CODE_SHELL_PREFIX. Claude Code runs
# every Bash tool command through it as one argument, and its MCP server launches as a command
# line: a Bash tool command is appended to ORCA_706_SHELL_LOG (one JSON string per line) before
# it runs, so a command that ran leaves a line, read independently of anything the agent says.
if [ "$#" -eq 1 ]; then
  case "$1" in
    *"eval "*) node -e 'process.stdout.write(JSON.stringify(process.argv[1]) + "\n")' "$1" >>"${ORCA_706_SHELL_LOG:?}" || exit 97 ;;
  esac
  exec /bin/bash -c "$1"
fi
exec "$@"
