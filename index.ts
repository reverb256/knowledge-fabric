import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	convertToLlm,
	serializeConversation,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { type ExtractedKnowledge, extractKnowledge } from "./lib/extract.js";
import { type IngestResult, ingestSource } from "./lib/ingest.js";
import {
	collectionSize,
	isHealthy as qdrantHealthy,
	upsert,
} from "./lib/qdrant.js";
import { type QueryResult, queryBrain } from "./lib/query-v2.js";
import {
	BRAIN_DIR,
	type BrainState,
	DAILY_DIR,
	ensureBrainDirs,
	getRawDir,
	getWikiDir,
	loadState,
	saveState,
	todayLogPath,
} from "./lib/state.js";
import {
	appendToDailyLog,
	readIndex,
} from "./lib/utils.js";

const BRAIN_VERSION = "1.0.0";

// Track background ingestions for status reporting
const pendingIngests: Array<{ name: string; started: string }> = [];
const completedIngests: Array<{
	name: string;
	status: string;
	pages: string[];
}> = [];

export default function brain(pi: ExtensionAPI) {
	// ── Before Agent Start: Inject brain context into system prompt ──
	pi.on("before_agent_start", async (event, _ctx) => {
		ensureBrainDirs();

		const parts: string[] = [];

		// 1. CORE.md — top-ranked learnings + watch-outs
		const corePath = join(BRAIN_DIR, "core", "CORE.md");
		if (existsSync(corePath)) {
			const core = readFileSync(corePath, "utf-8").trim();
			if (core) parts.push(core);
		}

		// 2. Last daily log (most recent only, capped)
		const recentDailies = getRecentDailyLogs(1);
		for (const log of recentDailies) {
			parts.push(log.content);
		}

		// 3. Brain index — compressed: page names + summaries
		const indexContent = readIndex();
		if (indexContent) {
			const compressed = compressIndex(indexContent);
			if (compressed) parts.push(compressed);
		}

		// 4. Recent wiki page stubs — top recently updated pages
		const recentStubs = getRecentWikiStubs(5);
		if (recentStubs) {
			parts.push(recentStubs);
		}

		if (parts.length === 0) return;

		const brainContext = parts.join("\n\n");
		return {
			systemPrompt: event.systemPrompt + "\n\n" + brainContext,
		};
	});

	// ── Before Compaction: Capture context before it's lost ──────────
	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, signal } = event;
		const messages = [
			...preparation.messagesToSummarize,
			...preparation.turnPrefixMessages,
		];
		if (messages.length === 0) return;

		try {
			const text = serializeConversation(convertToLlm(messages));
			const extracted = await extractKnowledge(
				text,
				undefined,
				undefined,
				undefined,
				signal,
				"fast",
			);

			if (extracted && extracted.items.length > 0) {
				appendTodDailyLog(formatExtractedForDailyLog(extracted));
				const state = loadState();
				state.lastFlush = new Date().toISOString();
				state.flushCount = (state.flushCount || 0) + 1;
				saveState(state);
			}
		} catch (err) {
			console.error("[brain] extraction during compact failed:", err);
		}
	});

	// ── Session Shutdown: Extract → Qdrant, health check ────────────
	pi.on("session_shutdown", async (_event, ctx) => {
		const entries = ctx.sessionManager.getBranch();
		const messages = entries.filter(
			(e: any) =>
				e.type === "message" &&
				e.message?.role &&
				(e.message.role === "user" || e.message.role === "assistant"),
		);
		if (messages.length < 4) return;

		try {
			const text = serializeConversation(convertToLlm(messages));
			if (text.length < 200) return;

			const extracted = await extractKnowledge(
				text,
				undefined,
				undefined,
				undefined,
				undefined,
				"fast",
			);
			if (extracted && extracted.items.length > 0) {
				// Always write to daily log as backup
				appendTodDailyLog(formatExtractedForDailyLog(extracted));

				// Primary path: upsert raw chunks to Qdrant
				try {
					if (await qdrantHealthy()) {
						const today = new Date().toISOString().slice(0, 10);
						const chunks = extracted.items.map((item) => ({
							content: item.content,
							source: "brain-extract",
							category: item.category,
							sessionDate: today,
						}));
						const count = await upsert("brain-sessions", chunks);
						console.log(`[brain] upserted ${count} chunks to Qdrant`);
					} else {
						console.log(
							"[brain] Qdrant unreachable, chunks in daily log only",
						);
					}
				} catch (qdrantErr: any) {
					console.error(
						`[brain] Qdrant upsert failed: ${qdrantErr.message}`,
					);
				}

				const state = loadState();
				state.lastFlush = new Date().toISOString();
				state.flushCount = (state.flushCount || 0) + 1;
				saveState(state);
			}
		} catch (err) {
			console.error("[brain] flush on shutdown failed:", err);
		}

		// Quick health check on shutdown
		try {
			const healthy = await qdrantHealthy();
			if (!healthy) console.log("[brain] auto-lint: Qdrant unreachable");
		} catch (err: any) {
			console.error("[brain] auto-lint error:", err.message);
		}
	});

	// ── Tool: brain_ingest ────────────────────────────────────────────
	pi.registerTool({
		name: "brain_ingest",
		label: "Brain Ingest",
		description:
			"Ingest a source (URL, file path, or text) into the knowledge base. Embeds and stores in Qdrant.",
		promptSnippet: "Ingest a source into the brain knowledge base",
		promptGuidelines: [
			"Use brain_ingest when the user shares a URL, article, paper, or any source they want preserved in the knowledge base.",
		],
		parameters: Type.Object({
			source: Type.String({
				description: "URL, file path, or text content to ingest",
			}),
			type: StringEnum(["url", "file", "text"] as const, {
				description: "Type of source",
				default: "url",
			}),
			name: Type.Optional(
				Type.String({ description: "Optional name for the source" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			ensureBrainDirs();
			const name = params.name || params.source.slice(0, 40);
			pendingIngests.push({ name, started: new Date().toISOString() });

			ingestSource(
				{ type: params.type, content: params.source, name: params.name },
				ctx,
				undefined,
			)
				.then(async (result) => {
					completedIngests.push({
						name: result.name,
						status: "ok",
						pages: [...result.pagesCreated, ...result.pagesUpdated],
					});
					console.log(
						`[brain] async ingest done: ${result.name} — created: ${result.pagesCreated.join(",")} updated: ${result.pagesUpdated.join(",")}`,
					);
					// v2: Also upsert to Qdrant
					try {
						if (await qdrantHealthy()) {
							const chunks = [];
							for (const page of [
								...result.pagesCreated,
								...result.pagesUpdated,
							]) {
								const pagePath = join(getWikiDir(), `${page}.md`);
								if (existsSync(pagePath)) {
									const content = readFileSync(pagePath, "utf-8");
									const body = content
										.replace(/^---[\s\S]*?---\n/, "")
										.trim();
									if (body.length > 20) {
										chunks.push({ content: body, source: `wiki:${page}` });
									}
								}
							}
							if (chunks.length > 0) {
								const count = await upsert("brain-wiki", chunks);
								console.log(
									`[brain] upserted ${count} wiki chunks to Qdrant`,
								);
							}
						}
					} catch (qdrantErr: any) {
						console.error(
							`[brain] Qdrant upsert after ingest: ${qdrantErr.message}`,
						);
					}
				})
				.catch((err: any) => {
					completedIngests.push({
						name,
						status: `failed: ${err.message}`,
						pages: [],
					});
					console.error(`[brain] async ingest failed: ${err.message}`);
				})
				.finally(() => {
					const idx = pendingIngests.findIndex((p) => p.name === name);
					if (idx >= 0) pendingIngests.splice(idx, 1);
				});

			return {
				content: [
					{
						type: "text",
						text: `**Ingesting:** ${name}\nProcessing in background. Check status with brain_status.`,
					},
				],
			};
		},
	});

	// ── Tool: brain_query ─────────────────────────────────────────────
	pi.registerTool({
		name: "brain_query",
		label: "Brain Query",
		description:
			"Query the knowledge base via Qdrant vector search + SearXNG web search. Returns synthesized answer with citations.",
		promptSnippet: "Query the brain knowledge base for stored knowledge",
		parameters: Type.Object({
			question: Type.String({
				description: "The question to ask the knowledge base",
			}),
			file_back: Type.Optional(
				Type.Boolean({
					description: "Save the answer back as a Q&A wiki page",
					default: false,
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			ensureBrainDirs();
			try {
				const result = await queryBrain(
					params.question,
					params.file_back ?? false,
					ctx,
					signal,
				);
				return {
					content: [{ type: "text", text: result.answer }],
					details: result,
				};
			} catch (err: any) {
				return {
					content: [{ type: "text", text: `Query failed: ${err.message}` }],
					isError: true,
				};
			}
		},
	});

	// ── Tool: brain_lint ──────────────────────────────────────────────
	pi.registerTool({
		name: "brain_lint",
		label: "Brain Lint",
		description:
			"Run health checks on the brain: Qdrant connectivity, collection sizes, embed endpoint, SearXNG.",
		promptSnippet: "Lint the brain knowledge base for issues",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, _ctx) {
			const checks: string[] = [];

			try {
				const healthy = await qdrantHealthy();
				if (healthy) {
					const [sessions, wiki, kb] = await Promise.all([
						collectionSize("brain-sessions"),
						collectionSize("brain-wiki"),
						collectionSize("knowledge_base"),
					]);
					checks.push(
						`✅ Qdrant: sessions=${sessions} wiki=${wiki} books=${kb}`,
					);
				} else {
					checks.push("❌ Qdrant: unreachable");
				}
			} catch (err: any) {
				checks.push(`❌ Qdrant: ${err.message}`);
			}

			try {
				const resp = await fetch("http://10.1.1.120:8643/health", {
					signal: AbortSignal.timeout(3000),
				});
				checks.push(
					resp.ok ? "✅ KB MCP embed endpoint" : `⚠️ KB MCP: ${resp.status}`,
				);
			} catch {
				checks.push("❌ KB MCP: unreachable");
			}

			try {
				const resp = await fetch(
					"http://10.1.1.120:30888/search?q=test&format=json",
					{ signal: AbortSignal.timeout(3000) },
				);
				if (resp.ok) {
					const data = (await resp.json()) as { results?: unknown[] };
					checks.push(`✅ SearXNG: ${data.results?.length ?? 0} results`);
				} else {
					checks.push(`⚠️ SearXNG: ${resp.status}`);
				}
			} catch {
				checks.push("❌ SearXNG: unreachable");
			}

			return {
				content: [
					{ type: "text", text: `🔍 Brain health:\n${checks.join("\n")}` },
				],
			};
		},
	});

	// ── Tool: brain_status ────────────────────────────────────────────
	pi.registerTool({
		name: "brain_status",
		label: "Brain Status",
		description: "Show brain knowledge base statistics and status.",
		promptSnippet: "Show brain knowledge base status",
		parameters: Type.Object({}),
		async execute() {
			ensureBrainDirs();
			const state = loadState();
			let qdrantInfo = "unreachable";
			try {
				const healthy = await qdrantHealthy();
				if (healthy) {
					const [sessions, wiki, kb] = await Promise.all([
						collectionSize("brain-sessions"),
						collectionSize("brain-wiki"),
						collectionSize("knowledge_base"),
					]);
					qdrantInfo = `sessions=${sessions} wiki=${wiki} books=${kb}`;
				}
			} catch {
				/* Qdrant down */
			}
			return {
				content: [{ type: "text", text: getBrainStatus(state, qdrantInfo) }],
				details: state,
			};
		},
	});

	// ── Commands ──────────────────────────────────────────────────────
	pi.registerCommand("brain", {
		description: "Show brain knowledge base status",
		handler: async (_args, ctx) => {
			ensureBrainDirs();
			ctx.ui.notify(getBrainStatus(loadState()), "info");
		},
	});
}

// ── Helper Functions ─────────────────────────────────────────────

function getBrainStatus(state: BrainState, qdrantInfo: string): string {
	const wikiDir = getWikiDir();
	const rawDir = getRawDir();

	const countFiles = (dir: string, ext = ".md"): number => {
		if (!existsSync(dir)) return 0;
		let count = 0;
		const walk = (d: string) => {
			for (const entry of readdirSync(d, { withFileTypes: true })) {
				if (entry.isDirectory()) walk(join(d, entry.name));
				else if (entry.name.endsWith(ext)) count++;
			}
		};
		walk(dir);
		return count;
	};

	return [
		`🧠 Brain Knowledge Base v${BRAIN_VERSION}`,
		`   Wiki pages: ${countFiles(wikiDir)} (browse-only)`,
		`   Daily logs: ${countFiles(DAILY_DIR)}`,
		`   Raw sources: ${countFiles(rawDir)}`,
		`   Qdrant: ${qdrantInfo}`,
		`   Last flush: ${state.lastFlush || "never"}`,
		`   Total flushes: ${state.flushCount || 0}`,
		pendingIngests.length > 0
			? `   ⏳ Ingesting: ${pendingIngests.map((p) => p.name).join(", ")}`
			: null,
		completedIngests.length > 0
			? `   ✅ Recent ingests: ${completedIngests
					.slice(-3)
					.map((c) => `${c.name} (${c.status})`)
					.join(", ")}`
			: null,
	]
		.filter(Boolean)
		.join("\n");
}

function compressIndex(indexMd: string): string {
	const pagePattern = /\[\[([^\]]+)\]\]\s*\|\s*(.+?)\s*\|/g;
	const entries: string[] = [];
	let match: RegExpExecArray | null;
	while ((match = pagePattern.exec(indexMd)) !== null) {
		const name = match[1];
		const summary = match[2].trim();
		if (summary.length > 80) {
			entries.push(`- ${name}: ${summary.slice(0, 77)}...`);
		} else {
			entries.push(`- ${name}: ${summary}`);
		}
	}
	if (entries.length === 0) return "";
	const full = entries.join("\n");
	const capped =
		full.length > 4096
			? entries.slice(0, 30).join("\n") +
				`\n... and ${entries.length - 30} more. Use brain_query.`
			: full;
	return `## Brain Index (${entries.length} pages)\nUse brain_query to read any page.\n\n${capped}`;
}

function formatExtractedForDailyLog(extracted: ExtractedKnowledge): string {
	const lines: string[] = [];
	if (extracted.context) lines.push(`**Context:** ${extracted.context}`);
	for (const item of extracted.items) {
		lines.push(`- **[${item.category}]** ${item.content}`);
	}
	return lines.join("\n");
}

function appendTodDailyLog(content: string): void {
	appendToDailyLog(todayLogPath(), content);
}

function getRecentWikiStubs(count: number): string {
	const wikiDir = getWikiDir();
	if (!existsSync(wikiDir)) return "";

	const files: Array<{ path: string; name: string; mtime: number }> = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory()) walk(join(dir, entry.name));
			else if (entry.name.endsWith(".md")) {
				const fullPath = join(dir, entry.name);
				try {
					files.push({
						path: fullPath,
						name: entry.name.replace(".md", ""),
						mtime: statSync(fullPath).mtimeMs,
					});
				} catch {
					/* skip */
				}
			}
		}
	};
	walk(wikiDir);
	files.sort((a, b) => b.mtime - a.mtime);

	const stubs = files.slice(0, count).map((f) => {
		try {
			const raw = readFileSync(f.path, "utf-8");
			const summaryMatch = raw.match(
				/^---\n[\s\S]*?summary:\s*(.+)\n[\s\S]*?---/,
			);
			const summary = summaryMatch?.[1]?.trim() || "";
			const bodyMatch = raw.match(/^---[\s\S]*?---\n\n([\s\S]+)/);
			const body = bodyMatch?.[1]?.trim()?.slice(0, 200) || "";
			return `- **${f.name}**: ${summary}${body ? "\n  " + body + "..." : ""}`;
		} catch {
			return `- **${f.name}**: (unreadable)`;
		}
	});

	return stubs.length > 0
		? `## Recent Wiki Pages\nUse brain_query for full content.\n\n${stubs.join("\n")}`
		: "";
}

function getRecentDailyLogs(
	count: number,
): Array<{ date: string; content: string }> {
	if (!existsSync(DAILY_DIR)) return [];

	const files: Array<{ path: string; date: string; mtime: number }> = [];
	for (const entry of readdirSync(DAILY_DIR)) {
		if (!entry.endsWith(".md")) continue;
		const fullPath = join(DAILY_DIR, entry);
		try {
			const mtime = statSync(fullPath).mtimeMs;
			files.push({ path: fullPath, date: entry.replace(".md", ""), mtime });
		} catch {
			/* skip */
		}
	}

	files.sort((a, b) => b.mtime - a.mtime);

	return files.slice(0, count).map(({ path, date }) => {
		try {
			const content = readFileSync(path, "utf-8").trim();
			const capped =
				content.length > 6144
					? content.slice(0, 6144) + "\n...(truncated)"
					: content;
			return { date, content: capped };
		} catch {
			return { date, content: `(unreadable: ${date})` };
		}
	});
}
