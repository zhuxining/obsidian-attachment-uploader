/**
 * 从上传命令的 stdout 中提取 URL。
 * 兼容 URL 中含空格/括号的情况：取到行尾再裁掉包裹的引号。
 */
export function extractUrl(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const prefix = /^(?:Output URL|Uploaded|result|URL):\s*(https?:\/\/.*)$/i.exec(line);
    const nextLine = /^(?:Output URL|Uploaded|URL):?$/i.test(line);
    let candidate = (prefix?.[1] ?? (nextLine ? lines[i + 1] : line) ?? "").trim();
    candidate = candidate.replace(/^["']|["']$/g, "");
    if (!/^https?:\/\//i.test(candidate)) continue;
    try {
      const result = new URL(candidate);
      if (["http:", "https:"].includes(result.protocol) && result.hostname) return candidate;
    } catch {
      /* invalid URL, try the next line */
    }
  }
  return null;
}

/**
 * 生成 Markdown 链接可用的 URL。
 * uPic 等工具会把上传得到的 URL 再做一次百分号编码（如把 %E6 编成 %25E6），
 * 产生 %25 这种二次编码，直接访问会 404。因此要逐层解码直到不再出现 %25
 * （过度编码的标志），即可得到正确的单次编码 URL——此时绝不可再 encodeURI，
 * 否则 % 会被重新编回 %25。仅当 URL 完全未编码（不含任何 %）时，才补一次
 * encodeURI 把中文/空格等归一化为合法 URL。
 * 括号在 Markdown 裸链接里会提前截断，因此含括号时用尖括号 <...> 包裹。
 */
export function toMarkdownUrl(url: string): string {
  let value = url.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = value.replace(/%25(?=[0-9a-f]{2})/gi, "%");
    if (next === value) break;
    value = next;
  }
  // Preserve existing %XX sequences when encoding remaining Unicode/whitespace.
  value = encodeURI(value).replace(/%25([0-9a-f]{2})/gi, "%$1");
  return /[()]/.test(value) ? `<${value}>` : value;
}
