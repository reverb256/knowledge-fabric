/**
 * Shared utilities for the brain extension.
 */

import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	BRAIN_DIR,
	DAILY_DIR,
	INDEX_PATH,
	LOG_PATH,
	WIKI_DIR,
} from "./state.js";

export function fileHash(filePath: string): string {
	const content = readFileSync(filePath);
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function readIndex(): string | null {
	if (!existsSync(INDEX_PATH)) return null;
	return readFileSync(INDEX_PATH, "utf-8");
}

export function readSchema(): string | null {
	const schemaPath = join(BRAIN_DIR, "SCHEMA.md");
	if (!existsSync(schemaPath)) return null;
	return readFileSync(schemaPath, "utf-8");
}

export function appendToLog(content: string): void {
	const timestamp = new Date().toISOString();
	const entry = `\n## [${timestamp}] ${content}\n`;
	appendFileSync(LOG_PATH, entry, "utf-8");
}

export function appendToDailyLog(logPath: string, content: string): void {
	const dir = dirname(logPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	if (!existsSync(logPath)) {
		const today =
			logPath.split("/").pop()?.replace(".md", "") ??
			new Date().toISOString().slice(0, 10);
		const header = `# Daily Log: ${today}\n\n## Sessions\n\n`;
		appendFileSync(logPath, header, "utf-8");
	}

	const time = new Date().toISOString().slice(11, 16);
	const entry = `\n### Session (${time})\n\n${content}\n`;
	appendFileSync(logPath, entry, "utf-8");
}

export function listWikiArticles(): string[] {
	const articles: string[] = [];
	if (!existsSync(WIKI_DIR)) return articles;

	const walk = (dir: string) => {
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const fullPath = join(dir, entry.name);
				if (entry.isDirectory()) walk(fullPath);
				else if (entry.name.endsWith(".md") && entry.name !== "overview.md") {
					articles.push(fullPath);
				}
			}
		} catch {
			// Permission denied or similar
		}
	};
	walk(WIKI_DIR);
	return articles;
}

export function listDailyLogs(): string[] {
	if (!existsSync(DAILY_DIR)) return [];
	return readdirSync(DAILY_DIR)
		.filter((f) => f.endsWith(".md"))
		.sort()
		.map((f) => join(DAILY_DIR, f));
}

export function readWikiPage(relPath: string): string | null {
	let fullPath = join(WIKI_DIR, relPath);
	if (!existsSync(fullPath) && !fullPath.endsWith(".md")) fullPath += ".md";
	if (!existsSync(fullPath)) return null;
	return readFileSync(fullPath, "utf-8");
}

export function writeWikiPage(relPath: string, content: string): void {
	let fullPath = join(WIKI_DIR, relPath);
	if (!fullPath.endsWith(".md")) fullPath += ".md";
	const dir = dirname(fullPath);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(fullPath, content, "utf-8");
}
