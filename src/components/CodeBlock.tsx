import { useState, useMemo, useCallback } from "react";
import { Check, Copy } from "lucide-react";

// ---- Token types for syntax highlighting ----
type TokenType =
  | "keyword"
  | "type"
  | "string"
  | "number"
  | "comment"
  | "operator"
  | "punctuation"
  | "function"
  | "property"
  | "constant"
  | "plain"
  | "diff-add"
  | "diff-remove"
  | "diff-header";

interface Token {
  type: TokenType;
  value: string;
}

// Language display names
const LANG_DISPLAY: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  typescript: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  javascript: "JavaScript",
  py: "Python",
  python: "Python",
  go: "Go",
  rust: "Rust",
  rs: "Rust",
  rb: "Ruby",
  ruby: "Ruby",
  java: "Java",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  css: "CSS",
  html: "HTML",
  sql: "SQL",
  diff: "Diff",
  md: "Markdown",
  markdown: "Markdown",
};

// Token color classes — carefully chosen to complement the dark theme
const TOKEN_COLORS: Record<TokenType, string> = {
  keyword: "text-[#c792ea]",       // soft purple — control flow
  type: "text-[#ffcb6b]",          // warm gold — types & classes
  string: "text-[#c3e88d]",        // green — strings
  number: "text-[#f78c6c]",        // coral — numeric literals
  comment: "text-[#546e7a] italic", // muted slate — comments
  operator: "text-[#89ddff]",      // cyan — operators
  punctuation: "text-[#89ddff80]", // dimmed cyan — braces, parens
  function: "text-[#82aaff]",      // blue — function names
  property: "text-[#f07178]",      // red-pink — properties
  constant: "text-[#f78c6c]",      // coral — constants
  plain: "",                       // inherit
  "diff-add": "text-[#c3e88d] bg-[#c3e88d10]",
  "diff-remove": "text-[#f07178] bg-[#f0717810]",
  "diff-header": "text-[#82aaff] font-semibold",
};

// ---- Tokenizer ----

const JS_KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class",
  "const", "continue", "debugger", "default", "delete", "do", "else",
  "enum", "export", "extends", "finally", "for", "from", "function",
  "get", "if", "implements", "import", "in", "instanceof", "interface",
  "let", "new", "of", "package", "private", "protected", "public",
  "readonly", "return", "set", "static", "super", "switch", "throw",
  "try", "type", "typeof", "var", "void", "while", "with", "yield",
]);

const JS_TYPES = new Set([
  "any", "boolean", "never", "null", "number", "object", "string",
  "symbol", "undefined", "unknown", "void", "Array", "Promise",
  "Record", "Partial", "Required", "Readonly", "Pick", "Omit",
  "Map", "Set", "Date", "Error", "RegExp", "Function", "Object",
  "String", "Number", "Boolean", "Symbol", "BigInt",
]);

const JS_CONSTANTS = new Set([
  "true", "false", "null", "undefined", "NaN", "Infinity", "this",
  "console", "window", "document", "globalThis", "process",
]);

function tokenizeLine(line: string, lang: string): Token[] {
  if (lang === "diff") return tokenizeDiff(line);
  return tokenizeJS(line);
}

function tokenizeDiff(line: string): Token[] {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) {
    return [{ type: "diff-header", value: line }];
  }
  if (line.startsWith("+")) {
    return [{ type: "diff-add", value: line }];
  }
  if (line.startsWith("-")) {
    return [{ type: "diff-remove", value: line }];
  }
  return [{ type: "plain", value: line }];
}

function tokenizeJS(line: string): Token[] {
  const tokens: Token[] = [];
  // Regex matches: line comments, block comment starts, strings, template literals,
  // numbers, identifiers, operators, punctuation, whitespace
  const regex =
    /(\/\/.*$)|(\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?n?)|\b([a-zA-Z_$][\w$]*)\b|([+\-*/%=!<>&|^~?:]+|\.{3})|([()[\]{},;.])|(\s+)/g;

  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = regex.exec(line)) !== null) {
    // Gap — shouldn't happen, but safety net
    if (match.index > lastIndex) {
      tokens.push({ type: "plain", value: line.slice(lastIndex, match.index) });
    }

    if (match[1]) {
      tokens.push({ type: "comment", value: match[1] });
    } else if (match[2]) {
      tokens.push({ type: "comment", value: match[2] });
    } else if (match[3]) {
      tokens.push({ type: "string", value: match[3] });
    } else if (match[4]) {
      tokens.push({ type: "number", value: match[4] });
    } else if (match[5]) {
      const word = match[5];
      if (JS_KEYWORDS.has(word)) {
        tokens.push({ type: "keyword", value: word });
      } else if (JS_TYPES.has(word)) {
        tokens.push({ type: "type", value: word });
      } else if (JS_CONSTANTS.has(word)) {
        tokens.push({ type: "constant", value: word });
      } else {
        // Check if next non-space char is ( → function call
        const rest = line.slice(match.index + word.length);
        if (/^\s*[(<]/.test(rest)) {
          tokens.push({ type: "function", value: word });
        } else if (/^\s*:/.test(rest) || line.slice(0, match.index).match(/\.\s*$/)) {
          tokens.push({ type: "property", value: word });
        } else {
          tokens.push({ type: "plain", value: word });
        }
      }
    } else if (match[6]) {
      tokens.push({ type: "operator", value: match[6] });
    } else if (match[7]) {
      tokens.push({ type: "punctuation", value: match[7] });
    } else if (match[8]) {
      tokens.push({ type: "plain", value: match[8] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < line.length) {
    tokens.push({ type: "plain", value: line.slice(lastIndex) });
  }

  return tokens;
}

// ---- Component ----

interface CodeBlockProps {
  code: string;
  lang: string;
}

export function CodeBlock({ code, lang }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => code.split("\n"), [code]);
  const displayLang = LANG_DISPLAY[lang] ?? (lang || "Code");
  const gutterWidth = String(lines.length).length;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [code]);

  return (
    <div className="group/code rounded-lg border border-[#1e1e2e] overflow-hidden bg-[#0d0d14]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-1.5 bg-[#12121c] border-b border-[#1e1e2e]">
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <div className="w-2 h-2 rounded-full bg-[#ff5f57]/60" />
            <div className="w-2 h-2 rounded-full bg-[#febc2e]/60" />
            <div className="w-2 h-2 rounded-full bg-[#28c840]/60" />
          </div>
          <span className="text-[10px] font-medium tracking-wide uppercase text-muted-foreground/60 ml-1.5">
            {displayLang}
          </span>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors opacity-0 group-hover/code:opacity-100"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check className="w-3 h-3" />
              <span>Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3 h-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code body */}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px] leading-[1.6] font-mono">
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className="hover:bg-white/[0.02]">
                {/* Line number */}
                <td
                  className="sticky left-0 select-none text-right pr-4 pl-4 text-muted-foreground/25 bg-[#0d0d14] align-top"
                  style={{ width: `${gutterWidth + 3}ch` }}
                >
                  {i + 1}
                </td>
                {/* Code */}
                <td className="pr-4 whitespace-pre">
                  <HighlightedLine tokens={tokenizeLine(line, lang)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function HighlightedLine({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, i) => {
        const cls = TOKEN_COLORS[token.type];
        if (!cls) return <span key={i}>{token.value}</span>;
        return (
          <span key={i} className={cls}>
            {token.value}
          </span>
        );
      })}
    </>
  );
}
