/** biome-ignore-all lint/style/useNodejsImportProtocol: <obsidian limit> */
import { normalizePath, type TFile } from "obsidian";
import { parse } from "path";

export interface Attachment {
	basename: string;
	alt: string;
	name: string;
	ext: string;
	source: string;
	existenceState: "network" | "local" | "missing";
	inVaultPath: string;
	inSystemPath: string;
}

export class AttachmentMatcher {
	private app: { vault: { getFiles: () => TFile[]; adapter: any } };

	constructor(app: { vault: { getFiles: () => TFile[]; adapter: any } }) {
		this.app = app;
	}

	/**
	 * 获取编辑器中所有的附件
	 * 解析编辑器内容，找出符合条件的附件，条件为符合markdown链接格式![]()
	 */
	getEditorAttachments(markdownFile: { editor?: { getValue: () => string } }): Attachment[] {
		const content = markdownFile.editor?.getValue() ?? "";
		const regex = /!\[(.*?)\]\((.*?)\)|!\[\[([^\]]+)\]\]/g;
		const matches = content.match(regex);
		if (!matches) return [];

		const vaultSystemPath = this.app.vault.adapter.getBasePath?.() || "";
		return matches
			.map((match: string) => this.parseAttachment(match, vaultSystemPath))
			.filter((attachment: Attachment | null): attachment is Attachment => attachment !== null);
	}

	/**
	 * 解析单个附件
	 * 从匹配的字符串中提取附件信息
	 */
	private parseAttachment(match: string, vaultSystemPath: string): Attachment | null {
		let attSourcePath: string | undefined;
		let alt: string | undefined;

		// Handle ![]() format
		if (match.includes("(") && match.includes(")")) {
			attSourcePath = match.match(/\((.*?)\)/)?.[1];
			alt = match.match(/\[(.*?)\]/)?.[1];
		}
		// Handle ![[]] format
		else if (match.startsWith("![[") && match.endsWith("]]")) {
			attSourcePath = match.match(/\[\[(.*?)\]\]/)?.[1];
		}

		if (!attSourcePath) return null;

		// 确保正确解码 URI 编码的路径
		const decodedPath = decodeURI(attSourcePath);
		const file = parse(normalizePath(decodedPath));

		// 使用更精确的文件查找方法
		const searchFile = this.app.vault
			.getFiles()
			.find(
				(f: TFile) =>
					f.path.toLowerCase() === normalizePath(decodedPath).toLowerCase() ||
					f.name.toLowerCase() === (file.name + file.ext).toLowerCase(),
			);

		return {
			source: match,
			alt: alt ?? file.name,
			basename: file.base,
			name: file.name,
			ext: file.ext,
			existenceState: attSourcePath.startsWith("http")
				? "network"
				: searchFile
					? "local"
					: "missing",
			inVaultPath: searchFile ? searchFile.path : normalizePath(decodedPath),
			inSystemPath: searchFile
				? `${vaultSystemPath}/${searchFile.path}`
				: normalizePath(decodedPath),
		};
	}
}
