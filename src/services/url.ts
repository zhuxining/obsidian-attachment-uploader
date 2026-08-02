/**
 * 从上传命令的 stdout 中提取 URL。
 * 兼容 URL 中含空格/括号的情况：取到行尾再裁掉包裹的引号。
 */
export function extractUrl(stdout: string): string | null {
  const match = stdout.match(/https?:\/\/[^\n]*/);
  if (!match) return null;
  return match[0].trim().replace(/^["']|["']$/g, "");
}

/**
 * 生成 Markdown 链接可用的 URL。
 * 先安全解码再做一次 encodeURI，避免对已编码序列（如 %20）二次编码；
 * 括号在 Markdown 裸链接里会提前截断，因此含括号时用尖括号 <...> 包裹。
 */
export function toMarkdownUrl(url: string): string {
  let raw = url;
  try {
    raw = decodeURIComponent(url);
  } catch {
    // 含非法 % 序列（如 100%off），放弃解码，保留原样
    raw = url;
  }
  const encoded = encodeURI(raw);
  return /[()]/.test(encoded) ? `<${encoded}>` : encoded;
}
