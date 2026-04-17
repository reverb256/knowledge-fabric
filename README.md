# Knowledge Fabric

Standalone knowledge base engine — Qdrant-backed vector search with RRF fusion, knowledge extraction from conversations, wiki compilation, and session context injection.

Originally extracted from the pi brain extension. Works as both a standalone library and a pi extension.

## What It Does

| Feature | Description |
|---------|-------------|
| **Knowledge Extraction** | Extracts decisions, lessons, gotchas, and patterns from conversation text using tiered LLM routing |
| **Wiki Compilation** | Three-phase pipeline (Plan → Extract → Generate) transforms raw sources into cross-referenced wiki pages |
| **Vector Search** | Qdrant-backed semantic search across `brain-sessions`, `brain-wiki`, and `knowledge_base` collections |
| **RRF Fusion** | Reciprocal Rank Fusion merges local vector results with SearXNG web search results |
| **Session Injection** | Automatically injects CORE.md, recent daily logs, brain index, and wiki stubs into system prompts |
| **Health Checks** | Structural linting: broken links, orphan pages, sparse articles, knowledge gaps, contradictions |

## Architecture

```
Conversation → Extract → Daily Log → Compile → Wiki Pages → Inject
                  ↓                                   ↓
              Qdrant upsert                    Qdrant upsert
                                                   ↓
                                           brain_query (RRF fusion)
```

### LLM Provider Chain

Tiered routing with automatic fallback:

| Tier | Priority | Use Case |
|------|----------|----------|
| `fast` | E2B (sentry) → ZAI → llama-cpp → NIM | Extraction, relevance, JSON |
| `quality` | E4B (llama-cpp) → ZAI → NIM → sentry | Synthesis, compilation |
| `verify` | NIM → ZAI → llama-cpp → sentry | Quality gates |

Reads provider config from `~/.pi/agent/models.json`.

## Tools (Pi Extension)

| Tool | Purpose |
|------|---------|
| `brain_ingest` | Ingest URL, file, or text into the knowledge base |
| `brain_query` | Query via Qdrant vector search + SearXNG web search, returns synthesized answer with citations |
| `brain_lint` | Health checks: Qdrant connectivity, collection sizes, embed endpoint, SearXNG |
| `brain_status` | Show statistics: wiki pages, daily logs, Qdrant state |

## Configuration

### Required Services

| Service | Default URL | Purpose |
|---------|-------------|---------|
| **Qdrant** | `http://10.1.1.120:6333` | Vector store for semantic search |
| **Embed endpoint** | `http://10.1.1.120:8643/embed` | Text → vector embedding (384d) |
| **SearXNG** | `http://10.1.1.120:30888` | Web search for RRF fusion |

### Data Directory

All data lives in `~/brain/`:

```
~/brain/
├── core/CORE.md      ← Top-ranked learnings (injected into every session)
├── daily/            ← Extracted daily conversation logs
├── wiki/             ← LLM-maintained cross-referenced knowledge base
│   ├── concepts/
│   ├── connections/
│   ├── entities/
│   ├── sources/
│   ├── comparisons/
│   └── qa/
├── raw/              ← Immutable source documents
├── queries/          ← Filed query answers
├── index.md          ← Catalog of every wiki page
├── state.json        ← Extension state (managed automatically)
└── log.md            ← Chronological operation log
```

## Install as Pi Extension

### Option A: Direct copy (simplest)

```bash
# Copy the whole project as the brain extension
cp -r /data/projects/own/knowledge-fabric ~/.pi/agent/extensions/brain
```

### Option B: Thin wrapper (recommended for development)

```bash
# Keep the standalone project separate
cp pi-extension/index.ts ~/.pi/agent/extensions/brain/index.ts

# Edit the import path in the wrapper to point at your checkout
# e.g., import brain from "/data/projects/own/knowledge-fabric/index.ts";
```

## Development

```bash
# Enter dev shell
nix develop

# Install dependencies
npm install

# Build
npm run build

# Type-check
npm run lint

# Watch mode
npm run dev
```

## Nix

```bash
# Build the package
nix build

# Enter dev shell
nix develop
```

## API (Library Usage)

```typescript
import { extractKnowledge } from "./lib/extract.js";
import { queryBrain } from "./lib/query-v2.js";
import { ingestSource } from "./lib/ingest.js";
import { lintWiki } from "./lib/lint.js";

// Extract knowledge from conversation text
const extracted = await extractKnowledge(text, undefined, undefined, undefined, signal, "fast");

// Query the knowledge base
const result = await queryBrain("How does RRF fusion work?", false, ctx, signal);

// Ingest a source
const ingestResult = await ingestSource({ type: "url", content: "https://..." }, ctx, signal);

// Lint the wiki
const report = await lintWiki(false, ctx, signal);
```

## License

MIT
