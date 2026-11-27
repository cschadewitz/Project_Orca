# Agent questions

An agent can ask the person running it a question in the middle of a turn: Claude's
`AskUserQuestion`, a Codex question (`request_user_input`), or a form an MCP server asks for
through its agent. Over ACP these arrive as `elicitation/create` with a form. ORCA shows the
question where permission asks appear, and sends the person's answer back to the agent
(#1133 for Claude, #1169 for Codex).

## What the person sees

- **In the app**, a question card in Attention and in the run's step, beside permission asks:
  the agent's message, who is asking, and the form. **Answer** sends the form; **Decline** tells
  the agent the person would not answer. There is no "always": a question is answered once.
- **At the terminal** (`humanInput.mode: cli`), one prompt per field. An empty line skips an
  optional field and `!decline` declines the whole question.

The answer is recorded in the run's log (`human.answered`), like any other answer.

## What ORCA offers and refuses

ORCA advertises form elicitation (`clientCapabilities.elicitation.form`) at `initialize` when a
session can ask somebody. It does not offer URL elicitation, so it never sends a person to a
page an agent names. The form ORCA shows is a closed subset of the agent's JSON Schema: single
choice, multiple choice, text, number and yes/no fields, within fixed limits
(`ELICITATION_LIMITS`). ORCA **declines** without showing anybody:

- a form with a field outside that subset, rather than showing part of it;
- a form that asks for a secret (`writeOnly`, `format: password`, or Codex's `isSecret`): the
  answer would be written to the run's log;
- a form with no fields. That is a confirmation, the shape an approval takes, and a question is
  never permission authority;
- a URL elicitation, or one for a request rather than this session's live prompt.

A question for another session, or one that arrives outside a live turn, is cancelled.

## Who answers

Only a person. The permission policy, its rules and the plain-language judge never answer a
question, and nothing answers one on a person's behalf:

- an unattended run (`humanInput.mode: auto`) asks nobody, even with an `option` configured,
  and the agent hears `cancel`;
- a question never parks a run. Like a permission ask it holds the agent's turn open, so it can
  only be answered while that turn's callback is pending; after a daemon restart, or once the
  turn ends, it is gone and the agent hears `cancel`. `orca answer` on a parked run refuses one.

The daemon checks every answer against the form the agent sent, field by field, before it is
recorded: a value outside a field's options or bounds, an unknown field or a missing required
field is refused and the question stays open. The engine checks it again before it reaches the
agent.

`cancel` and `decline` mean different things to the agents: Claude treats a decline as the
person skipping the question and a cancel as the tool call being stopped; Codex answers its
question blank either way.

## Which agents

Agents opened through the generic ACP session, which is how Claude (`claude-agent-acp`) and
Codex (`codex-acp`) run, are offered questions. Agents with a provider guard (GitHub Copilot
CLI, OpenCode, Cline) are not: questions were not part of the pinned behaviour their guard
vouches for, so they refuse `elicitation/create` as before (`agent-support.md`). Their own
question tools can be added per agent once their behaviour is pinned.

The Claude Agent SDK driver and the Codex app-server route handle questions separately (#1135,
#1170).

## For clients

An agent question is a `question` input (`inputs.list`) whose `context.elicitation` is the form
(`ElicitationFormSchema` in `@orca/protocol`). It carries `live` like a permission ask, and is
answered through `inputs.answer` with that `live` target and, as `optionId`, the JSON of the
answer: `{"action":"accept","content":{...}}` or `{"action":"decline"}`
(`encodeElicitationAnswer`). `always` is refused for it. A client that does not know the form
sees a free-text question whose plain text answers are refused, so nothing reaches the agent by
accident.

Code: `packages/core/src/model/elicitation.ts` (the form and the answer check),
`packages/agents/src/acp-session.ts` (`askElicitation`), `packages/engine/src/orchestrator.ts`
and `live-input.ts`, `packages/app/renderer/src/attention/question-card.tsx`.
