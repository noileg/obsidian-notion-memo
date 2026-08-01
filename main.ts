import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	requestUrl,
} from "obsidian";

/**
 * このvault全体を「AIが介在しないメモ」専用として扱う前提の設計。
 * フォルダによる絞り込みはしない（vault自体を分けることで対象を絞る運用のため）。
 * Notion側のメモは1子ページ=1本文として扱う。Markdownの見出し・リスト・
 * チェックボックス・引用・コードブロックと、太字/斜体/インラインコードの
 * 範囲装飾はNotionのブロック種別・rich_text annotationsに変換する
 * （それ以外の書式・ネストは今のところ対象外）。
 */

interface NotionMemoSettings {
	notionToken: string;
	parentPageId: string;
	notionVersion: string;
	autoSyncOnSave: boolean;
	autoPullMinutes: number; // 0で自動pullなし
}

const DEFAULT_SETTINGS: NotionMemoSettings = {
	notionToken: "",
	// 「Obsidianメモ置き場（同期用）」ページ（クロコのNotionセットアップ配下）。
	parentPageId: "3ea66ce3-d0b2-4b15-a01b-0dafd9e35cac",
	notionVersion: "2026-03-11",
	autoSyncOnSave: true,
	autoPullMinutes: 5,
};

const FRONTMATTER_ID_KEY = "notion_id";
const FRONTMATTER_HASH_KEY = "notion_hash";
const FRONTMATTER_PULLED_AT_KEY = "notion_pulled_at";
const PUSH_DEBOUNCE_MS = 3000;
const RICH_TEXT_LIMIT = 2000; // Notion APIの1要素あたりの文字数上限

function hashString(value: string): string {
	// 同期済みかどうかの軽い判定用。暗号強度は不要（衝突しても実害は
	// 「無駄にもう1回同期する」程度で、データが壊れることはない）。
	let hash = 5381;
	for (let i = 0; i < value.length; i++) {
		hash = (hash * 33) ^ value.charCodeAt(i);
	}
	return (hash >>> 0).toString(16);
}

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---\n")) return content;
	const end = content.indexOf("\n---", 4);
	if (end === -1) return content;
	const after = content.indexOf("\n", end + 1);
	return after === -1 ? "" : content.slice(after + 1);
}

/** フロントマター部分（`---`〜`---`とその直後の改行まで）だけを取り出す。無ければ空文字。 */
function frontmatterBlockOf(content: string): string {
	if (!content.startsWith("---\n")) return "";
	const end = content.indexOf("\n---", 4);
	if (end === -1) return "";
	const after = content.indexOf("\n", end + 1);
	return after === -1 ? content : content.slice(0, after + 1);
}

function sanitizeFilename(title: string): string {
	return title.replace(/[\\/:*?"<>|]/g, "_").trim() || "無題";
}

// --- インライン装飾（太字/斜体/コード）の相互変換 ---------------------------

interface RichTextRun {
	text: string;
	annotations: { bold?: boolean; italic?: boolean; code?: boolean };
}

/** `**太字**` `*斜体*`/`_斜体_` `` `コード` `` を区間ごとのrunに分解する。ネストは扱わない。 */
function parseInline(text: string): RichTextRun[] {
	const runs: RichTextRun[] = [];
	let buffer = "";
	let i = 0;
	const flush = () => {
		if (buffer) runs.push({ text: buffer, annotations: {} });
		buffer = "";
	};
	while (i < text.length) {
		if (text.startsWith("**", i)) {
			const end = text.indexOf("**", i + 2);
			if (end !== -1) {
				flush();
				runs.push({ text: text.slice(i + 2, end), annotations: { bold: true } });
				i = end + 2;
				continue;
			}
		} else if (text[i] === "`") {
			const end = text.indexOf("`", i + 1);
			if (end !== -1) {
				flush();
				runs.push({ text: text.slice(i + 1, end), annotations: { code: true } });
				i = end + 1;
				continue;
			}
		} else if ((text[i] === "*" || text[i] === "_") && text[i + 1] !== " " && text[i + 1] !== undefined) {
			const marker = text[i];
			const end = text.indexOf(marker, i + 1);
			if (end !== -1 && end > i + 1) {
				flush();
				runs.push({ text: text.slice(i + 1, end), annotations: { italic: true } });
				i = end + 1;
				continue;
			}
		}
		buffer += text[i];
		i++;
	}
	flush();
	return runs.length > 0 ? runs : [{ text: "", annotations: {} }];
}

function runsToRichText(runs: RichTextRun[]): unknown[] {
	const out: unknown[] = [];
	for (const run of runs) {
		const makeItem = (chunk: string): Record<string, unknown> => {
			const item: Record<string, unknown> = { type: "text", text: { content: chunk } };
			if (Object.keys(run.annotations).length > 0) item.annotations = run.annotations;
			return item;
		};
		if (run.text.length === 0) {
			out.push(makeItem(""));
			continue;
		}
		for (let i = 0; i < run.text.length; i += RICH_TEXT_LIMIT) {
			out.push(makeItem(run.text.slice(i, i + RICH_TEXT_LIMIT)));
		}
	}
	return out.length > 0 ? out : [{ type: "text", text: { content: "" } }];
}

function richTextToMarkdown(richText: any[] | undefined): string {
	return (richText ?? [])
		.map((rt: any) => {
			let s: string = rt.plain_text ?? "";
			const a = rt.annotations ?? {};
			if (a.code) s = `\`${s}\``;
			if (a.bold) s = `**${s}**`;
			if (a.italic) s = `*${s}*`;
			return s;
		})
		.join("");
}

// --- ブロック単位（見出し/リスト/チェックボックス/引用/コード/段落）の相互変換 ---

type Block =
	| { kind: "heading_1" | "heading_2" | "heading_3"; text: string }
	| { kind: "bulleted_list_item" | "numbered_list_item"; text: string }
	| { kind: "to_do"; text: string; checked: boolean }
	| { kind: "quote"; text: string }
	| { kind: "code"; text: string; language: string }
	| { kind: "paragraph"; text: string };

/** Markdown本文を行単位で解釈し、Notionのブロック種別に対応するBlock列に変換する。 */
function linesToBlocks(text: string): Block[] {
	const lines = text.split("\n");
	const blocks: Block[] = [];
	let paragraphBuffer: string[] = [];
	const flushParagraph = () => {
		if (paragraphBuffer.length > 0) {
			blocks.push({ kind: "paragraph", text: paragraphBuffer.join("\n") });
			paragraphBuffer = [];
		}
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed === "") {
			flushParagraph();
			i++;
			continue;
		}

		const codeFence = trimmed.match(/^```(\S*)\s*$/);
		if (codeFence) {
			flushParagraph();
			const language = codeFence[1] || "plain text";
			const codeLines: string[] = [];
			i++;
			while (i < lines.length && lines[i].trim() !== "```") {
				codeLines.push(lines[i]);
				i++;
			}
			i++; // 閉じの```を読み飛ばす（無くても末尾扱いで抜ける）
			blocks.push({ kind: "code", text: codeLines.join("\n"), language });
			continue;
		}

		const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
		if (heading) {
			flushParagraph();
			const level = Math.min(heading[1].length, 3);
			blocks.push({ kind: `heading_${level}` as "heading_1" | "heading_2" | "heading_3", text: heading[2] });
			i++;
			continue;
		}

		const todo = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
		if (todo) {
			flushParagraph();
			blocks.push({ kind: "to_do", text: todo[2], checked: todo[1].toLowerCase() === "x" });
			i++;
			continue;
		}

		const bullet = trimmed.match(/^[-*]\s+(.*)$/);
		if (bullet) {
			flushParagraph();
			blocks.push({ kind: "bulleted_list_item", text: bullet[1] });
			i++;
			continue;
		}

		const numbered = trimmed.match(/^\d+\.\s+(.*)$/);
		if (numbered) {
			flushParagraph();
			blocks.push({ kind: "numbered_list_item", text: numbered[1] });
			i++;
			continue;
		}

		const quote = trimmed.match(/^>\s?(.*)$/);
		if (quote) {
			flushParagraph();
			blocks.push({ kind: "quote", text: quote[1] });
			i++;
			continue;
		}

		paragraphBuffer.push(line);
		i++;
	}
	flushParagraph();
	return blocks;
}

function blockToNotionPayload(block: Block): Record<string, unknown> {
	if (block.kind === "code") {
		return {
			object: "block",
			type: "code",
			code: {
				rich_text: runsToRichText([{ text: block.text, annotations: {} }]),
				language: block.language,
			},
		};
	}
	const richText = runsToRichText(parseInline(block.text));
	switch (block.kind) {
		case "heading_1":
		case "heading_2":
		case "heading_3":
			return { object: "block", type: block.kind, [block.kind]: { rich_text: richText } };
		case "bulleted_list_item":
			return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: richText } };
		case "numbered_list_item":
			return { object: "block", type: "numbered_list_item", numbered_list_item: { rich_text: richText } };
		case "to_do":
			return {
				object: "block",
				type: "to_do",
				to_do: { rich_text: richText, checked: block.checked },
			};
		case "quote":
			return { object: "block", type: "quote", quote: { rich_text: richText } };
		case "paragraph":
		default:
			return { object: "block", type: "paragraph", paragraph: { rich_text: richText } };
	}
}

function bodyToNotionBlocks(text: string): Record<string, unknown>[] {
	return linesToBlocks(text).map(blockToNotionPayload);
}

/** Notionのブロック列（APIレスポンス）をMarkdown本文に戻す。 */
function blocksToMarkdown(blocks: any[]): string {
	const lines: string[] = [];
	let prevType: string | null = null;
	let numberedIndex = 0; // numbered_list_itemが連続する間だけ増える連番

	// 空行を挟まずに連続してよい種別（リスト系）。異なる種別の並びは
	// 視覚的に区切るため空行を挟む。
	const listLikeTypes = new Set(["bulleted_list_item", "numbered_list_item", "to_do"]);

	for (const block of blocks) {
		const type: string = block.type;
		let line: string;
		switch (type) {
			case "heading_1":
				line = "# " + richTextToMarkdown(block.heading_1?.rich_text);
				break;
			case "heading_2":
				line = "## " + richTextToMarkdown(block.heading_2?.rich_text);
				break;
			case "heading_3":
				line = "### " + richTextToMarkdown(block.heading_3?.rich_text);
				break;
			case "bulleted_list_item":
				line = "- " + richTextToMarkdown(block.bulleted_list_item?.rich_text);
				break;
			case "numbered_list_item":
				numberedIndex = prevType === "numbered_list_item" ? numberedIndex + 1 : 1;
				line = `${numberedIndex}. ` + richTextToMarkdown(block.numbered_list_item?.rich_text);
				break;
			case "to_do":
				line = `- [${block.to_do?.checked ? "x" : " "}] ` + richTextToMarkdown(block.to_do?.rich_text);
				break;
			case "quote":
				line = "> " + richTextToMarkdown(block.quote?.rich_text);
				break;
			case "code": {
				const lang = block.code?.language ?? "";
				const body = richTextToMarkdown(block.code?.rich_text);
				line = "```" + lang + "\n" + body + "\n```";
				break;
			}
			case "paragraph":
			default:
				line = richTextToMarkdown(block.paragraph?.rich_text ?? []);
				break;
		}

		const continuesList = listLikeTypes.has(type) && prevType === type;
		if (lines.length > 0 && !continuesList) lines.push("");
		lines.push(line);
		prevType = type;
	}

	return lines.join("\n");
}

class NotionClient {
	constructor(private token: string, private version: string) {}

	private async call(method: string, path: string, body?: unknown): Promise<any> {
		const res = await requestUrl({
			url: `https://api.notion.com/v1${path}`,
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Notion-Version": this.version,
				"Content-Type": "application/json",
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			throw: false,
		});
		if (res.status >= 400) {
			throw new Error(`Notion API ${method} ${path} -> ${res.status}: ${res.text}`);
		}
		return res.json;
	}

	async listChildPages(parentPageId: string): Promise<{ id: string; title: string }[]> {
		const out: { id: string; title: string }[] = [];
		let cursor: string | undefined;
		do {
			const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
			const data = await this.call("GET", `/blocks/${parentPageId}/children${qs}`);
			for (const block of data.results ?? []) {
				if (block.type === "child_page") {
					out.push({ id: block.id, title: block.child_page?.title ?? "" });
				}
			}
			cursor = data.has_more ? data.next_cursor : undefined;
		} while (cursor);
		return out;
	}

	async getPage(pageId: string): Promise<any> {
		return this.call("GET", `/pages/${pageId}`);
	}

	async getPageMarkdown(pageId: string): Promise<string> {
		const blocks: any[] = [];
		let cursor: string | undefined;
		do {
			const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
			const data = await this.call("GET", `/blocks/${pageId}/children${qs}`);
			blocks.push(...(data.results ?? []));
			cursor = data.has_more ? data.next_cursor : undefined;
		} while (cursor);
		return blocksToMarkdown(blocks);
	}

	async createPage(parentPageId: string, title: string, body: string): Promise<string> {
		const data = await this.call("POST", "/pages", {
			parent: { type: "page_id", page_id: parentPageId },
			properties: {
				title: { title: [{ type: "text", text: { content: title } }] },
			},
			// Notion APIは1回のページ作成で渡せる子ブロック数に上限があるため、
			// 最初の100件だけ渡し、残りはupdatePageContent同様に追加で送る。
			children: bodyToNotionBlocks(body).slice(0, 100),
		});
		const remaining = bodyToNotionBlocks(body).slice(100);
		if (remaining.length > 0) {
			await this.appendBlocks(data.id, remaining);
		}
		return data.id;
	}

	private async appendBlocks(pageId: string, blocks: Record<string, unknown>[]): Promise<void> {
		for (let i = 0; i < blocks.length; i += 100) {
			await this.call("PATCH", `/blocks/${pageId}/children`, {
				children: blocks.slice(i, i + 100),
			});
		}
	}

	async updatePageContent(pageId: string, title: string, body: string): Promise<void> {
		// タイトルはページプロパティ、本文はブロック。本文は「全消し→全追加」で
		// 置き換える（差分反映はしない。メモは頻繁に書き直さない前提のため、
		// 素朴な全置換で十分という判断）。
		await this.call("PATCH", `/pages/${pageId}`, {
			properties: {
				title: { title: [{ type: "text", text: { content: title } }] },
			},
		});

		const existing = await this.call("GET", `/blocks/${pageId}/children?page_size=100`);
		for (const block of existing.results ?? []) {
			await this.call("DELETE", `/blocks/${block.id}`);
		}
		const blocks = bodyToNotionBlocks(body);
		if (blocks.length > 0) {
			await this.appendBlocks(pageId, blocks);
		}
	}
}

export default class NotionMemoPlugin extends Plugin {
	settings!: NotionMemoSettings;
	private pendingPush = new Map<string, number>();
	// pull側が書いたファイルパス。自動push側の'modify'リスナーが、
	// pullの書き込みを人間の編集と誤認して即座に押し返すのを防ぐガード。
	private selfWritten = new Set<string>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new NotionMemoSettingTab(this.app, this));

		this.addCommand({
			id: "notion-memo-pull",
			name: "Notionから同期する",
			callback: () => this.pullFromNotion(),
		});
		this.addCommand({
			id: "notion-memo-push-current",
			name: "このメモをNotionへ今すぐ同期する",
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (file) this.pushNote(file);
			},
		});
		this.addCommand({
			id: "notion-memo-push-all",
			name: "vault内のすべてのメモをNotionへ送信する（プラグイン導入前からあったものも含む）",
			callback: () => this.pushAll(),
		});

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				if (this.selfWritten.has(file.path)) return; // pull自身の書き込みは無視
				if (this.settings.autoSyncOnSave) this.schedulePush(file);
			})
		);

		if (this.settings.autoPullMinutes > 0) {
			this.registerInterval(
				window.setInterval(
					() => this.pullFromNotion(),
					this.settings.autoPullMinutes * 60 * 1000
				)
			);
		}

		// モバイルはバックグラウンドでタイマーが動かないため、間隔設定より
		// 「アプリを開いた瞬間」の方が実質効く。起動のたびに1回pullする。
		if (this.settings.notionToken) {
			this.pullFromNotion().catch((err) => {
				console.error("[notion-memo] 起動時pull失敗", err);
			});
		}
	}

	onunload() {
		for (const timer of this.pendingPush.values()) window.clearTimeout(timer);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private client(): NotionClient {
		return new NotionClient(this.settings.notionToken, this.settings.notionVersion);
	}

	private markSelfWritten(path: string) {
		this.selfWritten.add(path);
		// 'modify'イベントの発火・購読側の処理が終わるのに十分な猶予を置いてから解除する。
		window.setTimeout(() => this.selfWritten.delete(path), PUSH_DEBOUNCE_MS + 1000);
	}

	private schedulePush(file: TFile) {
		const existing = this.pendingPush.get(file.path);
		if (existing) window.clearTimeout(existing);
		const timer = window.setTimeout(() => {
			this.pendingPush.delete(file.path);
			this.pushNote(file).catch((err) => {
				console.error("[notion-memo] push失敗", err);
				new Notice(`Notionへの同期に失敗しました: ${file.basename}`);
			});
		}, PUSH_DEBOUNCE_MS);
		this.pendingPush.set(file.path, timer);
	}

	async pushAll() {
		if (!this.settings.notionToken) {
			new Notice("Notionのトークンが未設定です（設定タブから入力してください）");
			return;
		}

		const files = this.app.vault.getMarkdownFiles();
		let sent = 0;
		let failed = 0;
		for (const file of files) {
			try {
				await this.pushNote(file);
				sent++;
			} catch (err) {
				console.error("[notion-memo] 一括送信中に失敗", file.path, err);
				failed++;
			}
			// Notion APIのレート制限（目安: 秒間数リクエスト）に配慮して少し間を空ける
			await new Promise((resolve) => window.setTimeout(resolve, 400));
		}
		new Notice(`一括送信完了: ${sent}件（失敗${failed}件）`);
	}

	async pushNote(file: TFile) {
		if (!this.settings.notionToken) return;

		const raw = await this.app.vault.read(file);
		const body = stripFrontmatter(raw).trim();
		const hash = hashString(body);
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter;
		const notionId: string | undefined = fm?.[FRONTMATTER_ID_KEY];

		if (fm?.[FRONTMATTER_HASH_KEY] === hash) return; // 実質変化なし

		const client = this.client();
		if (!notionId) {
			const newId = await client.createPage(this.settings.parentPageId, file.basename, body);
			await this.app.fileManager.processFrontMatter(file, (data) => {
				data[FRONTMATTER_ID_KEY] = newId;
				data[FRONTMATTER_HASH_KEY] = hash;
			});
			new Notice(`Notionへ新規作成: ${file.basename}`);
		} else {
			// 競合検知：前回同期時点からNotion側が別に変わっていないか確認する。
			// 確認せず上書きすると、Notion側での直接編集がここで消える
			// （このメモがまさに踏んだ不具合）。
			const knownHash = fm?.[FRONTMATTER_HASH_KEY];
			if (knownHash) {
				const remoteBody = await client.getPageMarkdown(notionId);
				const remoteHash = hashString(remoteBody);
				if (remoteHash !== knownHash) {
					new Notice(
						`Notion側が別に更新されているため送信を中止: ${file.basename}` +
							"（先に「Notionから同期する」を実行してください）"
					);
					return;
				}
			}
			await client.updatePageContent(notionId, file.basename, body);
			await this.app.fileManager.processFrontMatter(file, (data) => {
				data[FRONTMATTER_HASH_KEY] = hash;
			});
		}
	}

	async pullFromNotion() {
		if (!this.settings.notionToken) {
			new Notice("Notionのトークンが未設定です（設定タブから入力してください）");
			return;
		}

		const client = this.client();
		const children = await client.listChildPages(this.settings.parentPageId);

		// notion_id -> ローカルファイル の対応表を先に作る
		const byNotionId = new Map<string, TFile>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const id = this.app.metadataCache.getFileCache(file)?.frontmatter?.[FRONTMATTER_ID_KEY];
			if (id) byNotionId.set(id, file);
		}

		let created = 0;
		let updated = 0;

		for (const child of children) {
			const local = byNotionId.get(child.id);
			const page = await client.getPage(child.id);
			const lastEdited: string = page.last_edited_time ?? "";

			if (!local) {
				const body = await client.getPageMarkdown(child.id);
				const hash = hashString(body);
				const filename = `${sanitizeFilename(child.title)}.md`;
				const newFile = await this.app.vault.create(filename, body);
				this.markSelfWritten(newFile.path);
				await this.app.fileManager.processFrontMatter(newFile, (data) => {
					data[FRONTMATTER_ID_KEY] = child.id;
					data[FRONTMATTER_HASH_KEY] = hash;
					data[FRONTMATTER_PULLED_AT_KEY] = lastEdited;
				});
				created++;
				continue;
			}

			const localCache = this.app.metadataCache.getFileCache(local)?.frontmatter;
			const pulledAt = localCache?.[FRONTMATTER_PULLED_AT_KEY];
			if (pulledAt && pulledAt >= lastEdited) continue; // ローカルの方が新しいか同じ

			// 競合検知：ローカルに、まだNotionへ送信していない編集が残っていないか確認する。
			// 確認せず上書きすると、debounce待ちの間にpullが割り込んでローカルの
			// 編集を消してしまう（これがまさに踏んだ不具合）。
			const knownHash = localCache?.[FRONTMATTER_HASH_KEY];
			const currentLocalRaw = await this.app.vault.read(local);
			const currentLocalHash = hashString(stripFrontmatter(currentLocalRaw).trim());
			if (knownHash && currentLocalHash !== knownHash) continue; // 未送信の編集があるので今回は触らない

			const body = await client.getPageMarkdown(child.id);
			const hash = hashString(body);
			if (knownHash === hash) continue; // 中身は同じ

			this.markSelfWritten(local.path);
			// 先にフロントマターだけ更新（notion_idはここでは触らないので保持される）。
			// 本文の差し替えは、そのフロントマターを含めた全文を組み直してから行う
			// ——vault.modifyは全文置換であり、本文だけを渡すとフロントマター
			// （notion_id含む）が消えるバグがあったため、この順序にしている。
			await this.app.fileManager.processFrontMatter(local, (data) => {
				data[FRONTMATTER_HASH_KEY] = hash;
				data[FRONTMATTER_PULLED_AT_KEY] = lastEdited;
			});
			const updatedRaw = await this.app.vault.read(local);
			const fmBlock = frontmatterBlockOf(updatedRaw);
			await this.app.vault.modify(local, fmBlock + body);
			updated++;
		}

		new Notice(`Notionから同期: 新規${created}件・更新${updated}件`);
	}
}

class NotionMemoSettingTab extends PluginSettingTab {
	plugin: NotionMemoPlugin;

	constructor(app: App, plugin: NotionMemoPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Notion Integration Token")
			.setDesc("Notionの「Obsidianメモ置き場（同期用）」ページに接続したintegrationのトークン")
			.addText((text) =>
				text
					.setPlaceholder("secret_...")
					.setValue(this.plugin.settings.notionToken)
					.onChange(async (value) => {
						this.plugin.settings.notionToken = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("親ページID")
			.setDesc("Obsidianのメモを子ページとして格納するNotion親ページのID")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.parentPageId)
					.onChange(async (value) => {
						this.plugin.settings.parentPageId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("保存時に自動でNotionへ送信する")
			.setDesc("オフにすると、コマンド実行時にしか送信しない")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSyncOnSave).onChange(async (value) => {
					this.plugin.settings.autoSyncOnSave = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Notionから自動で取り込む間隔（分）")
			.setDesc("0にすると自動では取り込まず、手動同期のみになる。変更はObsidianの再読み込み後に反映")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.autoPullMinutes))
					.onChange(async (value) => {
						const n = Number(value);
						this.plugin.settings.autoPullMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("既存メモを一括送信")
			.setDesc(
				"プラグイン導入前から vault にあったメモは、編集イベントが起きるまで自動送信されない。" +
					"導入直後に一度これを押すと、vault内の全メモをまとめて送信する。"
			)
			.addButton((button) =>
				button.setButtonText("すべて送信").onClick(() => this.plugin.pushAll())
			);

		new Setting(containerEl)
			.setName("Notionから同期")
			.setDesc("Notion側の親ページ配下を今すぐ取り込む")
			.addButton((button) =>
				button.setButtonText("今すぐ同期").onClick(() => this.plugin.pullFromNotion())
			);
	}
}
