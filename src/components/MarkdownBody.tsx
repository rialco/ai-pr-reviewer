import { useMemo } from "react";
import { CodeBlock } from "./CodeBlock";

/**
 * Lightweight GitHub-flavored markdown renderer for bot comment bodies.
 * Handles: images, links, inline code, code blocks, bold, italic, headers,
 * blockquotes, horizontal rules, and unordered/ordered lists.
 */
export function MarkdownBody({ text }: { text: string }) {
  const elements = useMemo(() => parseMarkdown(htmlToMarkdown(text)), [text]);
  return <div className="text-sm text-foreground/90 leading-relaxed space-y-2">{elements}</div>;
}

/**
 * Convert common HTML tags found in bot comments to their markdown equivalents.
 * This runs before the markdown parser so everything goes through one rendering path.
 */
function htmlToMarkdown(html: string): string {
  let s = html;

  // Remove Greptile/Copilot action links (Fix in Claude Code, Fix in Codex, etc.)
  // These are giant URL-encoded prompt strings that aren't useful in the dashboard.
  // Matches: <a href="https://app.greptile.com/...">...<picture>...</picture>...</a> and similar patterns
  s = s.replace(/<a\s[^>]*href="https:\/\/app\.greptile\.com\/ide\/[^"]*"[^>]*>[\s\S]*?<\/a>/gi, "");
  // Also catch markdown-converted versions: [Fix in Claude Code](https://app.greptile.com/ide/...)
  s = s.replace(/\[!?\[?[^\]]*\]?\([^)]*\)\]?\(https:\/\/app\.greptile\.com\/ide\/[^)]*\)/gi, "");

  // Remove <picture>...</picture> blocks — extract the fallback <img> inside
  s = s.replace(/<picture[^>]*>([\s\S]*?)<\/picture>/gi, (_match, inner: string) => {
    const imgMatch = (inner as string).match(/<img\s[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/i)
      ?? (inner as string).match(/<img\s[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/i);
    if (imgMatch) {
      // Normalize: first capture group pattern may vary
      const src = imgMatch[1].startsWith("http") ? imgMatch[1] : imgMatch[2];
      const alt = imgMatch[1].startsWith("http") ? imgMatch[2] : imgMatch[1];
      return `![${alt}](${src})`;
    }
    return "";
  });

  // <a href="..."><img ... /></a> → image linked (just render the image)
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>\s*<img\s[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>\s*<\/a>/gi,
    (_m, _href, src, alt) => `![${alt}](${src})`);

  // <a href="..."><img alt="..." src="..." /></a> (alt before src)
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>\s*<img\s[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>\s*<\/a>/gi,
    (_m, _href, alt, src) => `![${alt}](${src})`);

  // Standalone <img> tags
  s = s.replace(/<img\s[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, (_m, src, alt) => `![${alt}](${src})`);
  s = s.replace(/<img\s[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, (_m, alt, src) => `![${alt}](${src})`);

  // <a href="...">text</a> → [text](href)
  s = s.replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const cleanText = (text as string).replace(/<[^>]+>/g, "").trim();
    if (!cleanText) return "";
    return `[${cleanText}](${href})`;
  });

  // <strong>text</strong> / <b>text</b>
  s = s.replace(/<(?:strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**");

  // <em>text</em> / <i>text</i>
  s = s.replace(/<(?:em|i)>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*");

  // <code>text</code>
  s = s.replace(/<code>([\s\S]*?)<\/code>/gi, "`$1`");

  // <br> / <br/>
  s = s.replace(/<br\s*\/?>/gi, "\n");

  // <p>text</p>
  s = s.replace(/<p>([\s\S]*?)<\/p>/gi, "$1\n\n");

  // <source> tags (leftover from picture)
  s = s.replace(/<source[^>]*\/?>/gi, "");

  // Any remaining HTML tags — strip them
  s = s.replace(/<\/?\w+[^>]*>/g, "");

  // Remove markdown links to greptile IDE that survived conversion
  s = s.replace(/!?\[[^\]]*\]\(https:\/\/app\.greptile\.com\/ide\/[^)]*\)/gi, "");
  // Remove bare greptile IDE URLs
  s = s.replace(/https:\/\/app\.greptile\.com\/ide\/[^\s)>]*/gi, "");

  // Clean up excessive blank lines
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}


type BlockNode =
  | { type: "paragraph"; content: string }
  | { type: "code_block"; lang: string; content: string }
  | { type: "heading"; level: number; content: string }
  | { type: "blockquote"; content: string }
  | { type: "hr" }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "image"; alt: string; src: string }
  | { type: "table"; headers: string[]; rows: string[][] };

function parseMarkdown(text: string): React.ReactNode[] {
  const blocks = tokenize(text);
  return blocks.map((block, i) => renderBlock(block, i));
}

function tokenize(text: string): BlockNode[] {
  const blocks: BlockNode[] = [];
  const lines = text.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    const codeMatch = line.match(/^```(\w*)/);
    if (codeMatch) {
      const lang = codeMatch[1];
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code_block", lang, content: codeLines.join("\n") });
      i++; // skip closing ```
      continue;
    }

    // Horizontal rule
    if (/^(\s*[-*_]\s*){3,}$/.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, content: headingMatch[2] });
      i++;
      continue;
    }

    // Standalone image line (not inside text)
    const imageLineMatch = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imageLineMatch) {
      blocks.push({ type: "image", alt: imageLineMatch[1], src: imageLineMatch[2] });
      i++;
      continue;
    }

    // Table (detect header + separator)
    if (
      i + 1 < lines.length &&
      line.includes("|") &&
      /^\s*\|?\s*[-:]+[-| :]*$/.test(lines[i + 1])
    ) {
      const headers = parsePipeRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(parsePipeRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    // Blockquote
    if (line.startsWith("> ") || line === ">") {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i].startsWith("> ") || lines[i] === ">")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ type: "blockquote", content: quoteLines.join("\n") });
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", ordered: false, items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ type: "list", ordered: true, items });
      continue;
    }

    // Empty line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-empty lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].startsWith("# ") &&
      !lines[i].startsWith("> ") &&
      !/^\s*[-*+]\s/.test(lines[i]) &&
      !/^\s*\d+[.)]\s/.test(lines[i]) &&
      !/^(\s*[-*_]\s*){3,}$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: "paragraph", content: paraLines.join("\n") });
    }
  }

  return blocks;
}

function parsePipeRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderBlock(block: BlockNode, key: number): React.ReactNode {
  switch (block.type) {
    case "paragraph":
      return (
        <p key={key} className="whitespace-pre-wrap break-words">
          <InlineMarkdown text={block.content} />
        </p>
      );

    case "code_block":
      return <CodeBlock key={key} code={block.content} lang={block.lang} />;

    case "heading": {
      const sizes = ["text-lg font-bold", "text-base font-bold", "text-sm font-semibold", "text-sm font-medium", "text-xs font-medium", "text-xs font-medium"];
      const cls = sizes[block.level - 1] ?? sizes[5];
      // Use explicit elements to avoid dynamic tag type issues
      if (block.level === 1) return <h1 key={key} className={cls}><InlineMarkdown text={block.content} /></h1>;
      if (block.level === 2) return <h2 key={key} className={cls}><InlineMarkdown text={block.content} /></h2>;
      if (block.level === 3) return <h3 key={key} className={cls}><InlineMarkdown text={block.content} /></h3>;
      return <h4 key={key} className={cls}><InlineMarkdown text={block.content} /></h4>;
    }

    case "blockquote":
      return (
        <blockquote key={key} className="border-l-2 border-muted-foreground/30 pl-3 text-muted-foreground italic">
          <InlineMarkdown text={block.content} />
        </blockquote>
      );

    case "hr":
      return <hr key={key} className="border-border" />;

    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag key={key} className={`pl-5 space-y-0.5 ${block.ordered ? "list-decimal" : "list-disc"}`}>
          {block.items.map((item, j) => (
            <li key={j} className="break-words">
              <InlineMarkdown text={item} />
            </li>
          ))}
        </Tag>
      );
    }

    case "image":
      return (
        <img
          key={key}
          src={block.src}
          alt={block.alt}
          className="max-w-full h-auto rounded-md border border-border"
          loading="lazy"
        />
      );

    case "table":
      return (
        <div key={key} className="overflow-x-auto">
          <table className="text-xs border-collapse w-full">
            <thead>
              <tr>
                {block.headers.map((h, j) => (
                  <th key={j} className="border border-border px-2 py-1 text-left font-medium bg-muted/50">
                    <InlineMarkdown text={h} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, j) => (
                <tr key={j}>
                  {row.map((cell, k) => (
                    <td key={k} className="border border-border px-2 py-1">
                      <InlineMarkdown text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    default:
      return null;
  }
}

/**
 * Renders inline markdown: images, links, inline code, bold, italic, strikethrough.
 */
function InlineMarkdown({ text }: { text: string }) {
  const parts = useMemo(() => parseInline(text), [text]);
  return <>{parts}</>;
}

type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "image"; alt: string; src: string }
  | { type: "link"; text: string; href: string }
  | { type: "bold"; value: string }
  | { type: "italic"; value: string }
  | { type: "strikethrough"; value: string };

function parseInline(text: string): React.ReactNode[] {
  // Combined regex for all inline patterns
  const regex =
    /(`[^`]+`)|!\[([^\]]*)\]\(([^)]+)\)|\[([^\]]+)\]\(([^)]+)\)|(\*\*|__)(.+?)\3|(~~)(.+?)\8|([*_])(.+?)\10|(https?:\/\/[^\s<>)"]+)/g;

  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    // Text before this match
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    if (match[1]) {
      // Inline code
      nodes.push(
        <code key={match.index} className="rounded bg-muted px-1 py-0.5 text-xs font-mono">
          {match[1].slice(1, -1)}
        </code>,
      );
    } else if (match[2] !== undefined && match[3]) {
      // Image ![alt](src)
      nodes.push(
        <img
          key={match.index}
          src={match[3]}
          alt={match[2]}
          className="inline-block max-w-full h-auto rounded-md border border-border"
          loading="lazy"
        />,
      );
    } else if (match[4] && match[5]) {
      // Link [text](href)
      nodes.push(
        <a
          key={match.index}
          href={match[5]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {match[4]}
        </a>,
      );
    } else if (match[6] && match[7]) {
      // Bold **text** or __text__
      nodes.push(
        <strong key={match.index} className="font-semibold">
          {match[7]}
        </strong>,
      );
    } else if (match[8] && match[9]) {
      // Strikethrough ~~text~~
      nodes.push(
        <del key={match.index} className="line-through text-muted-foreground">
          {match[9]}
        </del>,
      );
    } else if (match[10] && match[11]) {
      // Italic *text* or _text_
      nodes.push(
        <em key={match.index}>{match[11]}</em>,
      );
    } else if (match[12]) {
      // Bare URL
      nodes.push(
        <a
          key={match.index}
          href={match[12]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {match[12]}
        </a>,
      );
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}
