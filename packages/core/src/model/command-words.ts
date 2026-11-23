/**
 * Command-word permission rules (#702): match a shell command by its words, not its text.
 *
 * A `titlePattern` is a regular expression over whatever the agent wrote as the title, so
 * "all git except push" written as a deny `^git push` misses `git -C repo push`. A `command`
 * rule is matched against the parsed command instead.
 *
 * A command rule can **deny** or **ask**, never **allow** (`COMMAND_ALLOW_REFUSED`, #702
 * review). Words are what the agent shows, not what runs: the executable a word resolves to,
 * the working directory, an alias, an npm script or a config file decide that, and ORCA
 * attests none of them while the agent runs the command in its own process. So a word match
 * is a hint, good for refusing or asking and never proof for an automatic yes.
 *
 * The match is lenient. The command is split into its simple commands (`&&`, `||`, `;`, `|`,
 * `&`, newlines), and a rule matches a part when the rule's program appears anywhere in it (by
 * name, so `/usr/bin/git` is `git`) and the rule's later words follow in order, with anything
 * in between: `git push` catches `git -C repo push`, `sudo git push`, `bash -c "git push"`,
 * and also `git log --grep push`. A wrong match only ever asks or refuses. The call gets the
 * strictest answer any part gets.
 *
 * A rule's `command` is written like a command: words separated by spaces, quoted where a word
 * holds a space. A final bare `*` means "and any further words": `npm *` is every npm command,
 * `git push` is `git push` and nothing else. Nothing here runs a shell.
 */

/** One simple command as words, plus what makes it uncertain to name exactly. */
export interface CommandPart {
  readonly words: readonly string[];
  /** Every word broken on whitespace and quotes, for the lenient match. */
  readonly loose: readonly string[];
  /** Why no rule can name this part exactly, if anything. */
  readonly unsure?: string;
}

export interface ParsedCommand {
  readonly parts: readonly CommandPart[];
  /** Why the text could not be read at all; `parts` then holds one loose-only part. */
  readonly unreadable?: string;
}

/** Programs whose arguments are another command, or that change how one runs. */
const WRAPPERS = new Set([
  "sudo",
  "doas",
  "su",
  "env",
  "command",
  "builtin",
  "exec",
  "eval",
  "source",
  ".",
  "xargs",
  "nohup",
  "time",
  "nice",
  "ionice",
  "timeout",
  "stdbuf",
  "chroot",
  "watch",
  "parallel",
  "script",
  "unbuffer",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "busybox",
  "pwsh",
  "powershell",
  "cmd",
  "npx",
  "pnpx",
  "bunx",
  "nix-shell",
  "ssh",
]);

/** A `cd` alone decides nothing; what follows it does. */
const NEUTRAL = new Set(["cd", "pushd", "popd"]);

const OPERATOR = /^(?:&&|\|\||;|\||&|\n)$/;

interface Token {
  text: string;
  /** The word held an unquoted `$`, backtick, glob character or brace. */
  expands: boolean;
  /** Operator token, not a word. */
  op?: boolean;
  redirect?: boolean;
}

/** Split shell text into words and operators. Undefined with a reason when it cannot. */
function tokenize(text: string): { tokens: Token[] } | { refused: string } {
  const tokens: Token[] = [];
  let i = 0;
  let word = "";
  let inWord = false;
  let expands = false;
  const end = () => {
    if (inWord) tokens.push({ text: word, expands });
    word = "";
    inWord = false;
    expands = false;
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t") {
      end();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n" || c === ";" || c === "&" || c === "|") {
      end();
      const two = text.slice(i, i + 2);
      if (two === "&&" || two === "||") {
        tokens.push({ text: two, expands: false, op: true });
        i += 2;
      } else if (c === "&" && text[i + 1] === ">") {
        tokens.push({ text: "&>", expands: false, redirect: true });
        i += 2;
      } else {
        tokens.push({ text: c, expands: false, op: true });
        i++;
      }
      continue;
    }
    if (c === "<" || c === ">") {
      // `2>&1` and `>&2` move output between streams; anything else reads or writes a file.
      const fd = /^\d+$/.test(word) && inWord ? word : "";
      if (fd !== "") {
        word = "";
        inWord = false;
      } else end();
      const rest = text.slice(i);
      const dup = /^[<>]&\d/.exec(rest);
      if (dup) {
        tokens.push({ text: fd + dup[0], expands: false, redirect: true });
        i += dup[0].length;
        continue;
      }
      if (rest.startsWith("<(") || rest.startsWith(">(")) return { refused: "process substitution" };
      const op = /^(?:>>|>\||<<<|<<-?|<>|>|<)/.exec(rest)![0];
      tokens.push({ text: fd + op, expands: false, redirect: true });
      i += op.length;
      continue;
    }
    if (c === "(" || c === ")") return { refused: "a subshell or grouping" };
    if (c === "#" && !inWord) {
      // A comment runs to the end of the line.
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    inWord = true;
    if (c === "\\") {
      if (i + 1 >= text.length) return { refused: "a trailing backslash" };
      if (text[i + 1] === "\n") i += 2;
      else {
        word += text[i + 1];
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return { refused: "an unclosed quote" };
      word += text.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= text.length) return { refused: "an unclosed quote" };
        const d = text[i]!;
        if (d === '"') {
          i++;
          break;
        }
        if (d === "`") return { refused: "command substitution" };
        if (d === "$") {
          if (text[i + 1] === "(") return { refused: "command substitution" };
          expands = true;
        }
        if (d === "\\" && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1]!)) {
          if (text[i + 1] !== "\n") word += text[i + 1];
          i += 2;
          continue;
        }
        word += d;
        i++;
      }
      continue;
    }
    if (c === "`") return { refused: "command substitution" };
    if (c === "$") {
      if (text[i + 1] === "(") return { refused: "command substitution" };
      expands = true;
    }
    if (c === "*" || c === "?" || c === "[" || c === "{" || c === "}" || c === "~") expands = true;
    word += c;
    i++;
  }
  end();
  return { tokens };
}

/** Words broken on whitespace and shell punctuation, for the lenient match only. */
function looseWords(text: string): string[] {
  return text.split(/[\s'"`;&|()<>{}$=\\]+/).filter((w) => w !== "");
}

/** A program word by name: `/usr/bin/git` and `git.exe` are both `git`. */
export function programName(word: string): string {
  const base = word.split(/[\\/]/).pop() ?? word;
  return base.replace(/\.(?:exe|cmd|bat|com)$/i, "").toLowerCase();
}

/** Read a command line into its simple commands. */
export function parseCommand(text: string): ParsedCommand {
  const t = tokenize(text);
  if ("refused" in t)
    return { parts: [{ words: [], loose: looseWords(text), unsure: t.refused }], unreadable: t.refused };
  const parts: CommandPart[] = [];
  let current: Token[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const words: string[] = [];
    let unsure: string | undefined;
    let skipTarget = false;
    let leading = true;
    for (const tok of current) {
      if (tok.redirect) {
        if (!/^\d*[<>]&\d$/.test(tok.text)) {
          unsure ??= "a redirection";
          skipTarget = true;
        }
        continue;
      }
      if (skipTarget) {
        skipTarget = false;
        continue;
      }
      if (leading && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok.text)) {
        unsure ??= "an environment assignment";
        continue;
      }
      leading = false;
      if (tok.expands) unsure ??= "a variable, glob or expansion";
      words.push(tok.text);
    }
    if (skipTarget) unsure ??= "a redirection";
    const loose = current.filter((tok) => !tok.redirect).flatMap((tok) => looseWords(tok.text));
    const program = words[0];
    if (program !== undefined && WRAPPERS.has(programName(program))) unsure ??= `a wrapper (${program})`;
    if (words.length > 0 || loose.length > 0) parts.push({ words, loose, ...(unsure ? { unsure } : {}) });
    current = [];
  };
  for (const tok of t.tokens) {
    if (tok.op && OPERATOR.test(tok.text)) flush();
    else current.push(tok);
  }
  flush();
  return { parts };
}

/** A rule's `command` as words, with a final bare `*` meaning "any further words". */
export interface CommandPattern {
  readonly words: readonly string[];
  readonly rest: boolean;
}

/**
 * Read a rule's `command`. Undefined when it names no program, holds an operator, or uses `*`
 * anywhere but as the last word.
 */
export function parseCommandPattern(text: string): CommandPattern | undefined {
  const t = tokenize(text);
  if ("refused" in t) return undefined;
  if (t.tokens.some((tok) => tok.op || tok.redirect)) return undefined;
  const words = t.tokens.map((tok) => tok.text);
  let rest = false;
  if (words.length > 0 && words[words.length - 1] === "*" && t.tokens[t.tokens.length - 1]!.expands) {
    rest = true;
    words.pop();
  }
  if (words.length === 0) return undefined;
  if (t.tokens.slice(0, words.length).some((tok) => tok.expands)) return undefined;
  return { words, rest };
}

/** The lenient match a deny or ask uses: the program by name, then the rest in order. */
export function commandCatches(pattern: CommandPattern, part: CommandPart): boolean {
  const want = pattern.words;
  const program = programName(want[0]!);
  const loose = part.loose;
  for (let start = 0; start < loose.length; start++) {
    if (programName(loose[start]!) !== program) continue;
    let k = 1;
    for (let j = start + 1; j < loose.length && k < want.length; j++) if (loose[j] === want[k]) k++;
    if (k === want.length) return true;
  }
  return false;
}

/** Whether a part decides nothing by itself (`cd dir`). */
export function neutralPart(part: CommandPart): boolean {
  return part.unsure === undefined && part.words.length <= 2 && NEUTRAL.has(programName(part.words[0] ?? ""));
}

/**
 * The command text of a tool call: `rawInput.command` when the agent sent one (a string, or an
 * argv array — `["bash", "-lc", script]` is read as the script), else the title with any
 * surrounding backticks removed. Undefined when there is no text.
 */
export function commandTextOf(toolCall: { title?: string | null | undefined; rawInput?: unknown }): string | undefined {
  const raw = toolCall.rawInput;
  const cmd = raw !== null && typeof raw === "object" ? (raw as { command?: unknown }).command : undefined;
  if (typeof cmd === "string" && cmd.trim() !== "") return cmd;
  if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((w): w is string => typeof w === "string")) {
    if (cmd.length === 3 && WRAPPERS.has(programName(cmd[0]!)) && /^-[a-z]*c$/.test(cmd[1]!)) return cmd[2];
    return cmd.map(quoteWord).join(" ");
  }
  const title = (toolCall.title ?? "").trim();
  if (title === "") return undefined;
  const fenced = /^`([^`]+)`$/.exec(title);
  return fenced ? fenced[1] : title;
}

/** Quote one argv word so that `parseCommand` reads it back as exactly that word. */
export function quoteWord(word: string): string {
  if (word !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Wider command patterns a person may save as a standing deny instead of the exact command
 * (#702), narrowest first: `npm run build` offers `npm run *` and `npm *`. Only for one
 * certain simple command whose program is not a shell or wrapper. Never an allow: see
 * `COMMAND_ALLOW_REFUSED`.
 */
export function broaderCommandPatterns(text: string): string[] {
  const parsed = parseCommand(text);
  const parts = parsed.parts.filter((p) => !neutralPart(p));
  if (parsed.unreadable !== undefined || parts.length !== 1) return [];
  const part = parts[0]!;
  if (part.unsure !== undefined || part.words.length < 2) return [];
  const [program, sub] = part.words as [string, string];
  const out: string[] = [];
  if (part.words.length > 2 && !sub.startsWith("-")) out.push(`${quoteWord(program)} ${quoteWord(sub)} *`);
  out.push(`${quoteWord(program)} *`);
  return out.filter((p) => parseCommandPattern(p) !== undefined);
}

/**
 * The MCP server and tool a call names in its metadata, when its agent puts them there
 * (#1021). Gemini CLI titles an MCP ask `create_issue(title: x)` or `create_issue (github MCP
 * Server)`, and keeps the server and tool only in `_meta["gemini-cli"].mcp`. `invalid` means
 * the agent said it is an MCP call but did not name both plainly.
 */
// eslint-disable-next-line no-control-regex
const MCP_NAME_CONTROL = /[\u0000-\u001f\u007f]/;

export function mcpToolOf(toolCall: { _meta?: unknown }): { server: string; tool: string } | "invalid" | undefined {
  const meta = toolCall._meta;
  if (meta === null || typeof meta !== "object") return undefined;
  const gemini = (meta as Record<string, unknown>)["gemini-cli"];
  if (gemini === null || typeof gemini !== "object") return undefined;
  if (!Object.hasOwn(gemini, "mcp")) return undefined;
  const mcp = (gemini as Record<string, unknown>)["mcp"];
  if (mcp === null || typeof mcp !== "object") return "invalid";
  const server = (mcp as Record<string, unknown>)["server_name"];
  const tool = (mcp as Record<string, unknown>)["tool_name"];
  const plain = (s: unknown): s is string =>
    typeof s === "string" && s.trim() === s && s !== "" && s.length <= 256 && !MCP_NAME_CONTROL.test(s);
  return plain(server) && plain(tool) ? { server, tool } : "invalid";
}

/**
 * The title a permission rule is matched against and recorded by (#1021): `server: tool` for
 * an MCP call whose agent names both in its metadata, as the Claude adapter titles one; the
 * agent's own title otherwise. Undefined for an MCP call that does not name both plainly:
 * nothing can be allowed or recorded by title for it.
 */
export function permissionTitleOf(toolCall: {
  title?: string | null | undefined;
  _meta?: unknown;
}): string | undefined {
  const mcp = mcpToolOf(toolCall);
  if (mcp === "invalid") return undefined;
  if (mcp) return `${mcp.server}: ${mcp.tool}`;
  return toolCall.title ?? "";
}
