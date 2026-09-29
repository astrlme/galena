// Incident updates are Markdown. The page renders a small subset, and escapes everything first,
// so no HTML from an update can ever reach the page: paragraphs, "- " lists, **bold**, *italic*
// or _italic_, and [links](https://…) with http, https or mailto targets only.

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*)[*_](?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
}

/** Safe HTML for an update's text. */
export function renderMarkdown(source: string): string {
  return source
    .trim()
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split("\n").map((l) => l.trim());
      if (lines.every((l) => l.startsWith("- "))) {
        return `<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join("")}</ul>`;
      }
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}
