import { createHighlighter, type Highlighter } from "shiki"

const EXTENSION_TO_LANG: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  cpp: "cpp",
  c: "c",
  css: "css",
  scss: "scss",
  html: "html",
  json: "json",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  php: "php",
  sh: "bash",
  bash: "bash",
  sql: "sql",
}

let highlighterPromise: Promise<Highlighter> | null = null

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: [...new Set(Object.values(EXTENSION_TO_LANG))],
    })
  }
  return highlighterPromise
}

export function getLangFromExtension(extension: string): string {
  const normalized = extension.toLowerCase().replace(/^\./, "")
  return EXTENSION_TO_LANG[normalized] ?? "text"
}

export async function highlightCode(
  code: string,
  extension: string,
  theme: "light" | "dark",
): Promise<string> {
  const highlighter = await getHighlighter()
  const lang = getLangFromExtension(extension)
  const themeName = theme === "dark" ? "github-dark" : "github-light"

  return highlighter.codeToHtml(code, {
    lang,
    theme: themeName,
  })
}
