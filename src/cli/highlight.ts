// Tiny in-house code highlighter for `olle chat` markdown rendering.
// Deliberately small and regex-based — not a full lexer. Covers the
// languages we expect agents to emit in v0: ts/js/json, python, bash/sh,
// sql. Anything else falls back to plain code-block coloring.
//
// Trade-off: regex tokenizers misclassify edge cases (eg. `//` inside a
// string in bash), but for streamed snippets the cost of being wrong
// occasionally is far smaller than dragging in highlight.js. We prioritize
// reading speed: keywords pop, strings are obviously strings, comments
// disappear into the gutter.

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
};

const STYLE = {
  keyword: `${ANSI.magenta}`,
  builtin: `${ANSI.cyan}`,
  string: `${ANSI.green}`,
  number: `${ANSI.yellow}`,
  comment: `${ANSI.dim}${ANSI.gray}`,
  literal: `${ANSI.yellow}`,
  punctuation: `${ANSI.dim}`,
  text: `${ANSI.green}`, // default code color
} as const;

type StyleKey = keyof typeof STYLE;

/** Normalize a fence info-string to a known language id, or "" if unsupported. */
export function normalizeLang(raw: string): string {
  const lang = raw.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!lang) return "";
  const aliases: Record<string, string> = {
    ts: "ts",
    typescript: "ts",
    tsx: "ts",
    js: "ts",
    javascript: "ts",
    jsx: "ts",
    mjs: "ts",
    cjs: "ts",
    json: "json",
    py: "python",
    python: "python",
    sh: "bash",
    bash: "bash",
    shell: "bash",
    zsh: "bash",
    sql: "sql",
  };
  return aliases[lang] ?? "";
}

interface Rule {
  re: RegExp;
  style: StyleKey;
}

// Keyword sets are stamped into a single alternation regex per language.
// Order matters: comments and strings come first so we don't mis-tokenize
// keyword-looking content inside them.
function buildRules(keywords: string[], builtins: string[], comments: RegExp[]): Rule[] {
  const kw = keywords.length > 0 ? new RegExp(`\\b(?:${keywords.join("|")})\\b`) : null;
  const bi = builtins.length > 0 ? new RegExp(`\\b(?:${builtins.join("|")})\\b`) : null;
  const rules: Rule[] = [];
  for (const c of comments) rules.push({ re: c, style: "comment" });
  // Strings: try triple-quoted (python), then double, then single, then template.
  rules.push({ re: /"""[\s\S]*?"""/, style: "string" });
  rules.push({ re: /'''[\s\S]*?'''/, style: "string" });
  rules.push({ re: /"(?:\\.|[^"\\])*"/, style: "string" });
  rules.push({ re: /'(?:\\.|[^'\\])*'/, style: "string" });
  rules.push({ re: /`(?:\\.|[^`\\])*`/, style: "string" });
  // Numbers (incl. hex, float, scientific).
  rules.push({ re: /\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b/, style: "number" });
  if (kw) rules.push({ re: kw, style: "keyword" });
  if (bi) rules.push({ re: bi, style: "builtin" });
  return rules;
}

const TS_KEYWORDS = [
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
  "extends", "finally", "for", "from", "function", "get", "if", "implements",
  "import", "in", "instanceof", "interface", "is", "keyof", "let", "namespace",
  "new", "null", "of", "package", "private", "protected", "public", "readonly",
  "return", "set", "static", "super", "switch", "this", "throw", "true", "try",
  "type", "typeof", "undefined", "var", "void", "while", "with", "yield", "false",
];
const TS_BUILTINS = [
  "Array", "Boolean", "Date", "Error", "JSON", "Map", "Math", "Number", "Object",
  "Promise", "RegExp", "Set", "String", "Symbol", "console", "document", "window",
];

const PY_KEYWORDS = [
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
  "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "True", "False", "None", "try", "while", "with", "yield",
];
const PY_BUILTINS = [
  "abs", "all", "any", "bool", "bytes", "dict", "enumerate", "filter", "float",
  "frozenset", "getattr", "hasattr", "hash", "id", "int", "isinstance", "iter",
  "len", "list", "map", "max", "min", "next", "object", "open", "ord", "print",
  "range", "repr", "reversed", "round", "set", "setattr", "slice", "sorted",
  "str", "sum", "super", "tuple", "type", "vars", "zip", "self",
];

const BASH_KEYWORDS = [
  "if", "then", "else", "elif", "fi", "case", "esac", "for", "while", "until",
  "do", "done", "in", "function", "return", "break", "continue", "exit",
  "local", "export", "readonly", "declare", "unset", "set", "shift", "trap",
];
const BASH_BUILTINS = [
  "echo", "printf", "read", "cd", "pwd", "ls", "cat", "grep", "sed", "awk",
  "find", "xargs", "test", "true", "false", "source",
];

const SQL_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
  "DELETE", "CREATE", "TABLE", "DROP", "ALTER", "INDEX", "JOIN", "LEFT",
  "RIGHT", "INNER", "OUTER", "ON", "AS", "AND", "OR", "NOT", "NULL", "IS",
  "IN", "LIKE", "BETWEEN", "GROUP", "BY", "ORDER", "HAVING", "LIMIT", "OFFSET",
  "DISTINCT", "UNION", "ALL", "CASE", "WHEN", "THEN", "ELSE", "END", "WITH",
  "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "DEFAULT", "UNIQUE", "CHECK",
  "INTEGER", "TEXT", "REAL", "BLOB", "VARCHAR", "BOOLEAN", "TIMESTAMP",
];

const RULES_BY_LANG: Record<string, Rule[]> = {
  ts: buildRules(TS_KEYWORDS, TS_BUILTINS, [/\/\/[^\n]*/, /\/\*[\s\S]*?\*\//]),
  json: [
    { re: /"(?:\\.|[^"\\])*"\s*:/, style: "keyword" }, // keys
    { re: /"(?:\\.|[^"\\])*"/, style: "string" },
    { re: /\b(?:true|false|null)\b/, style: "literal" },
    { re: /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, style: "number" },
  ],
  python: buildRules(PY_KEYWORDS, PY_BUILTINS, [/#[^\n]*/]),
  bash: buildRules(BASH_KEYWORDS, BASH_BUILTINS, [/#[^\n]*/]),
  // SQL: case-insensitive keyword match needs a tweak — wrap each keyword
  // in a case-insensitive group via the inline (?i) modifier.
  sql: (() => {
    const ci = (words: string[]) => new RegExp(`\\b(?:${words.join("|")})\\b`, "i");
    return [
      { re: /--[^\n]*/, style: "comment" as StyleKey },
      { re: /\/\*[\s\S]*?\*\//, style: "comment" as StyleKey },
      { re: /'(?:''|[^'])*'/, style: "string" as StyleKey },
      { re: /"(?:""|[^"])*"/, style: "string" as StyleKey },
      { re: /\b\d+(?:\.\d+)?\b/, style: "number" as StyleKey },
      { re: ci(SQL_KEYWORDS), style: "keyword" as StyleKey },
    ];
  })(),
};

/** Highlight a single line of code in the given normalized language.
 *  Returns the line with ANSI escape sequences applied. Lines without
 *  matches are still styled with the default code color so unhighlighted
 *  characters don't visually clash with highlighted ones. */
export function highlightCodeLine(line: string, lang: string): string {
  const rules = RULES_BY_LANG[lang];
  if (!rules || line.length === 0) return `${STYLE.text}${line}${ANSI.reset}`;

  // Collect non-overlapping matches by scanning the line and picking
  // the earliest match across all rules at each position.
  let out = "";
  let i = 0;
  while (i < line.length) {
    let bestStart = -1;
    let bestEnd = -1;
    let bestStyle: StyleKey = "text";
    for (const rule of rules) {
      // Anchor each match to or-after position i by setting lastIndex.
      const sub = line.slice(i);
      const m = rule.re.exec(sub);
      if (!m) continue;
      const start = i + m.index;
      const end = start + m[0].length;
      if (bestStart === -1 || start < bestStart || (start === bestStart && end - start > bestEnd - bestStart)) {
        bestStart = start;
        bestEnd = end;
        bestStyle = rule.style;
      }
    }
    if (bestStart === -1) {
      // No more matches — emit rest of line as plain code text.
      out += `${STYLE.text}${line.slice(i)}${ANSI.reset}`;
      break;
    }
    if (bestStart > i) {
      out += `${STYLE.text}${line.slice(i, bestStart)}${ANSI.reset}`;
    }
    out += `${STYLE[bestStyle]}${line.slice(bestStart, bestEnd)}${ANSI.reset}`;
    i = bestEnd;
  }
  return out;
}
