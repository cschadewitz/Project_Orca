- **agents:** Claude and Codex can ask you questions mid-turn. ORCA now offers ACP form
  elicitation, so Claude's `AskUserQuestion`, Codex's questions and MCP server forms reach you
  as a question card in Attention (or one prompt per field at the terminal), and your answer,
  or your decline, goes back to the agent. Before, Claude could not ask at all and Codex got
  blank answers. Only a person answers: an unattended run asks nobody, and forms that ask for
  a secret, have no fields or point at a URL are declined. See `docs/agent-questions.md`.
