/**
 * Markdown -> HTML, for handing the revised article back in the form the user
 * actually publishes.
 *
 * This is the exact inverse of `toMarkdown` in extract.ts rather than a general
 * markdown parser: we generate the markdown ourselves, so the subset is known
 * and closed (headings, paragraphs, lists, blockquotes, code fences, tables,
 * links, bold, italic, inline code). Writing the inverse keeps the output
 * predictable and avoids pulling a parser into the bundle to handle syntax this
 * pipeline never emits.
 *
 * Everything is escaped before any tag is introduced, so article text cannot
 * inject markup into the copied HTML.
 */

const CODE_PLACEHOLDER = (index: number) => `%%QAR_CODE_${index}%%`;

/**
 * Walk markdown links, balancing parentheses inside the URL.
 *
 * A regex that stops at the first ")" mangles any link whose URL legitimately
 * contains one — and automotive writing is full of them, from Wikipedia model
 * codes like /Toyota_RAV4_(XA50) to Maps links. The label survives even when
 * the URL is rejected, so hostile input degrades to plain text rather than
 * leaving a stray bracket in the copy.
 */
export function replaceMarkdownLinks(
  text: string,
  render: (label: string, url: string) => string,
): string {
  let out = "";
  let i = 0;

  while (i < text.length) {
    const open = text.indexOf("[", i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }

    const labelEnd = text.indexOf("]", open);
    if (labelEnd === -1 || text[labelEnd + 1] !== "(") {
      out += text.slice(i, open + 1);
      i = open + 1;
      continue;
    }

    let depth = 1;
    let cursor = labelEnd + 2;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === "(") depth += 1;
      else if (text[cursor] === ")") depth -= 1;
      cursor += 1;
    }

    if (depth !== 0) {
      out += text.slice(i, open + 1);
      i = open + 1;
      continue;
    }

    out += text.slice(i, open);
    out += render(text.slice(open + 1, labelEnd), text.slice(labelEnd + 2, cursor - 1));
    i = cursor;
  }

  return out;
}


function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Only http(s), mailto and same-site paths keep their href. */
function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^(?:https?:|mailto:)/i.test(trimmed)) return escapeHtml(trimmed);
  if (/^[/#]/.test(trimmed)) return escapeHtml(trimmed);
  return null;
}

function renderInline(text: string): string {
  let out = escapeHtml(text);

  // Code spans are lifted out first so their contents are not re-processed
  // for emphasis or links.
  const codeSpans: string[] = [];
  out = out.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeSpans.push(`<code>${code}</code>`);
    return CODE_PLACEHOLDER(codeSpans.length - 1);
  });

  out = replaceMarkdownLinks(out, (label, url) => {
    const href = safeHref(url);
    return href ? `<a href="${href}">${label}</a>` : label;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  return out.replace(/%%QAR_CODE_(\d+)%%/g, (_match, index: string) => codeSpans[Number(index)]);
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function renderTable(lines: string[]): string {
  const rows = lines.filter((line) => !TABLE_SEPARATOR.test(line)).map(splitRow);
  if (rows.length === 0) return "";

  const hasHeader = lines.length > 1 && TABLE_SEPARATOR.test(lines[1]);
  const [first, ...rest] = rows;
  const body = hasHeader ? rest : rows;

  const head = hasHeader
    ? `<thead><tr>${first.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr></thead>`
    : "";
  const cells = body
    .map((row) => `<tr>${row.map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`)
    .join("");

  return `<table>${head}<tbody>${cells}</tbody></table>`;
}

export function markdownToHtml(markdown: string): string {
  const blocks = markdown.split(/\n{2,}/);
  const out: string[] = [];

  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;

    const lines = block.split("\n");
    const first = lines[0];

    if (/^```/.test(first)) {
      const code = block.replace(/^```\w*\n?/, "").replace(/```$/, "");
      out.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
      continue;
    }

    if (/^\s*\|/.test(first)) {
      const table = renderTable(lines);
      if (table) out.push(table);
      continue;
    }

    const heading = first.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      continue;
    }

    if (/^\s{0,3}>/.test(first)) {
      const quote = lines.map((line) => line.replace(/^\s{0,3}>\s?/, "")).join(" ");
      out.push(`<blockquote><p>${renderInline(quote.trim())}</p></blockquote>`);
      continue;
    }

    if (/^\s{0,3}\d+\.\s/.test(first)) {
      const items = lines
        .map((line) => line.replace(/^\s{0,3}\d+\.\s+/, "").trim())
        .filter(Boolean)
        .map((item) => `<li>${renderInline(item)}</li>`)
        .join("");
      out.push(`<ol>${items}</ol>`);
      continue;
    }

    if (/^\s{0,3}[-*+]\s/.test(first)) {
      const items = lines
        .map((line) => line.replace(/^\s{0,3}[-*+]\s+/, "").trim())
        .filter(Boolean)
        .map((item) => `<li>${renderInline(item)}</li>`)
        .join("");
      out.push(`<ul>${items}</ul>`);
      continue;
    }

    out.push(`<p>${renderInline(lines.join(" ").trim())}</p>`);
  }

  return out.join("\n");
}
