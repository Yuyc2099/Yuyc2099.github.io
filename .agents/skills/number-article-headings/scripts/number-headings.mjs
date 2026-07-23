import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const inputs = args.filter((arg) => arg !== "--check");
const targets = inputs.length ? inputs : ["content/posts"];

const markdownFiles = [];

const collectMarkdown = async (target) => {
  const resolved = path.resolve(target);
  const info = await stat(resolved);

  if (info.isDirectory()) {
    const entries = await readdir(resolved, { withFileTypes: true });
    for (const entry of entries) {
      await collectMarkdown(path.join(resolved, entry.name));
    }
  } else if (resolved.endsWith(".md")) {
    markdownFiles.push(resolved);
  }
};

const numberHeadings = (source, file) => {
  const parts = source.split(/(\r\n|\n|\r)/);
  const lines = [];
  for (let index = 0; index < parts.length; index += 2) {
    lines.push({ text: parts[index], newline: parts[index + 1] ?? "" });
  }

  let fence = null;
  let section = 0;
  let subsection = 0;

  const numberLine = (line) => {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!fence) {
        fence = { character: marker[0], length: marker.length };
      } else if (marker[0] === fence.character && marker.length >= fence.length) {
        fence = null;
      }
      return line;
    }

    if (fence) return line;

    const heading = line.match(/^(#{2,3})[ \t]+(.+?)[ \t]*$/);
    if (!heading) return line;

    const [, marks, rawTitle] = heading;
    const title = rawTitle.replace(/^\d+(?:\.\d+)*\.?[ \t]+/, "");

    if (marks.length === 2) {
      section += 1;
      subsection = 0;
      return `## ${section}. ${title}`;
    }

    if (section === 0) {
      throw new Error(`${file}: 三级标题出现在首个二级标题之前`);
    }

    subsection += 1;
    return `### ${section}.${subsection} ${title}`;
  };

  return lines.map(({ text, newline }) => numberLine(text) + newline).join("");
};

for (const target of targets) await collectMarkdown(target);
markdownFiles.sort();

let changed = 0;
for (const file of markdownFiles) {
  const source = await readFile(file, "utf8");
  const numbered = numberHeadings(source, file);
  if (numbered === source) continue;

  changed += 1;
  console.log(`${checkOnly ? "需要更新" : "已更新"}: ${path.relative(process.cwd(), file)}`);
  if (!checkOnly) await writeFile(file, numbered, "utf8");
}

if (checkOnly && changed > 0) process.exitCode = 1;
if (changed === 0) console.log(`已检查 ${markdownFiles.length} 篇文章，标题编号无需调整。`);
