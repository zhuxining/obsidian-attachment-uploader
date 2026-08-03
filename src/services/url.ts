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
 * uPic 等工具会把上传得到的 URL 再做一次百分号编码（如把 %E6 编成 %25E6），
 * 产生 %25 这种二次编码，直接访问会 404。因此要逐层解码直到不再出现 %25
 * （过度编码的标志），即可得到正确的单次编码 URL——此时绝不可再 encodeURI，
 * 否则 % 会被重新编回 %25。仅当 URL 完全未编码（不含任何 %）时，才补一次
 * encodeURI 把中文/空格等归一化为合法 URL。
 * 括号在 Markdown 裸链接里会提前截断，因此含括号时用尖括号 <...> 包裹。
 */
export function toMarkdownUrl(url: string): string {
  let raw = url;
  // 只解码到不再出现 %25 为止，保留合法的 %XX 单次编码（如 %23、%3F）
  while (raw.includes("%25")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // 含非法 % 序列（如 100%off），停止解码，保留当前结果
      break;
    }
    if (decoded === raw) break; // 无可解码内容
    raw = decoded;
  }
  // 完全未编码（无 %）时补一次 encodeURI 归一化；已含 %XX 则跳过，避免二次编码
  if (!raw.includes("%")) {
    raw = encodeURI(raw);
  }
  return /[()]/.test(raw) ? `<${raw}>` : raw;
}
