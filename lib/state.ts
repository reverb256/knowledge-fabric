/**
 * State management for the brain extension.
 *
 * Tracks compile state, flush history, and daily log hashes.
 * All state lives in ~/brain/state.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BRAIN_DIR = join(homedir(), "brain");
export const DAILY_DIR = join(BRAIN_DIR, "daily");
export const WIKI_DIR = join(BRAIN_DIR, "wiki");
export const RAW_DIR = join(BRAIN_DIR, "raw");
export const QUERIES_DIR = join(BRAIN_DIR, "queries");
export const INDEX_PATH = join(BRAIN_DIR, "index.md");
export const LOG_PATH = join(BRAIN_DIR, "log.md");
export const SCHEMA_PATH = join(BRAIN_DIR, "SCHEMA.md");
export const STATE_PATH = join(BRAIN_DIR, "state.json");

export interface IngestedEntry {
	hash: string;
	compiled_at: string;
	cost_usd: number;
}

export interface BrainState {
	version: string;
	lastFlush?: string;
	lastCompile?: string;
	flushCount?: number;
	ingested?: Record<string, IngestedEntry>;
	totalCost?: number;
	queryCount?: number;
	lastLint?: string;
}

export function getBrainDir(): string {
	return BRAIN_DIR;
}
export function getDailyDir(): string {
	return DAILY_DIR;
}
export function getWikiDir(): string {
	return WIKI_DIR;
}
export function getRawDir(): string {
	return RAW_DIR;
}
export function getIndexPath(): string {
	return INDEX_PATH;
}
export function getLogPath(): string {
	return LOG_PATH;
}
export function getSchemaPath(): string {
	return SCHEMA_PATH;
}
export function getStatePath(): string {
	return STATE_PATH;
}

export function ensureBrainDirs(): void {
	const dirs = [BRAIN_DIR, DAILY_DIR, WIKI_DIR, RAW_DIR, QUERIES_DIR];
	const subdirs = [
		join(WIKI_DIR, "concepts"),
		join(WIKI_DIR, "connections"),
		join(WIKI_DIR, "entities"),
		join(WIKI_DIR, "sources"),
		join(WIKI_DIR, "comparisons"),
		join(WIKI_DIR, "domains"),
		join(WIKI_DIR, "qa"),
		join(RAW_DIR, "articles"),
		join(RAW_DIR, "papers"),
		join(RAW_DIR, "videos"),
		join(RAW_DIR, "repos"),
		join(RAW_DIR, "assets"),
		join(RAW_DIR, "sessions"),
	];
	for (const d of [...dirs, ...subdirs]) {
		if (!existsSync(d)) mkdirSync(d, { recursive: true });
	}
}

export function loadState(): BrainState {
	if (!existsSync(STATE_PATH)) {
		return {
			version: "1.0.0",
			ingested: {},
			totalCost: 0,
			flushCount: 0,
			queryCount: 0,
		};
	}
	try {
		return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
	} catch {
		return {
			version: "1.0.0",
			ingested: {},
			totalCost: 0,
			flushCount: 0,
			queryCount: 0,
		};
	}
}

export function saveState(state: BrainState): void {
	writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export function todayLogPath(): string {
	const today = new Date().toISOString().slice(0, 10);
	return join(DAILY_DIR, `${today}.md`);
}
