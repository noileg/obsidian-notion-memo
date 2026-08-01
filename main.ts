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
 * Notion側のメモは1子ページ=1本文（段落単位のプレーンテキスト）として扱い、
 * リッチな書式の相互変換は持たない（cf. croco/notion.pyのparagraph_blocks）。
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

function splitParagraphs(text: string): string[] {
	return text
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}

function chunkRichText(text: string): { type: "text"; text: { content: string } }[] {
	const chunks: { type: "text"; text: { content: string } }[] = [];
	for (let i = 0; i < text.length; i += RICH_TEXT_LIMIT) {
		chunks.push({ type: "text", text: { content: text.slice(i, i + RICH_TEXT_LIMIT) } });
	}
	return chunks.length > 0 ? chunks : [{ type: "text", text: { content: "" } }];
}

function sanitizeFilename(title: string): string {
	return title.replace(/[\\/:*?"<>|]/g, "_").trim() || "無題";
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

	async getPageParagraphs(pageId: string): Promise<string> {
		const paragraphs: string[] = [];
		let cursor: string | undefined;
		do {
			const qs = cursor ? `?start_cursor=${cursor}&page_size=100` : "?page_size=100";
			const data = await this.call("GET", `/blocks/${pageId}/children${qs}`);
			for (const block of data.results ?? []) {
				if (block.type === "paragraph") {
					const text = (block.paragraph?.rich_text ?? [])
						.map((rt: any) => rt.plain_text ?? "")
						.join("");
					paragraphs.push(text);
				}
			}
			cursor = data.has_more ? data.next_cursor : undefined;
		} while (cursor);
		return paragraphs.join("\n\n");
	}

	private paragraphBlocks(text: string) {
		return splitParagraphs(text).map((p) => ({
			object: "block",
			type: "paragraph",
			paragraph: { rich_text: chunkRichText(p) },
		}));
	}

	async createPage(parentPageId: string, title: string, body: string): Promise<string> {
		const data = await this.call("POST", "/pages", {
			parent: { type: "page_id", page_id: parentPageId },
			properties: {
				title: { title: [{ type: "text", text: { content: title } }] },
			},
			children: this.paragraphBlocks(body),
		});
		return data.id;
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
		const blocks = this.paragraphBlocks(body);
		if (blocks.length > 0) {
			await this.call("PATCH", `/blocks/${pageId}/children`, { children: blocks });
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
				const body = await client.getPageParagraphs(child.id);
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

			const body = await client.getPageParagraphs(child.id);
			const hash = hashString(body);
			if (localCache?.[FRONTMATTER_HASH_KEY] === hash) continue; // 中身は同じ

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
