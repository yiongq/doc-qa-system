# DocQA System

An AI-powered document Q&A system built with Next.js 14. Upload your documents, and ask questions in natural language — answers are generated with Retrieval-Augmented Generation (RAG) and backed by citations to the source text.

## Features

- 📄 **Document management** — upload, list, search, rename, and delete documents
- 🧩 **Parsing & chunking** — extracts text and splits it into semantic chunks
- 🔍 **Vector search** — embeds chunks and retrieves the most relevant passages
- 💬 **RAG-based Q&A** — multi-turn conversations grounded in your documents, with source citations
- 🔐 **Authentication** — email/password plus Google and GitHub OAuth (NextAuth v5)
- 📤 **Export** — export conversations

### Supported file formats

| Format | Extensions |
| ------ | ---------- |
| PDF | `.pdf` |
| Word | `.docx`, `.doc` |
| Markdown | `.md` |
| Plain text | `.txt` |

> ⚠️ **Text-only extraction.** Images are not accepted, and image-based content (scanned PDFs, screenshots embedded in slides/decks) is **not** extracted — there is no OCR or vision model in the pipeline. A PDF with no text layer will fail to parse.

## Tech Stack

| Layer | Technology |
| ----- | ---------- |
| Framework | Next.js 14 (App Router), React 18, TypeScript |
| Styling / UI | Tailwind CSS, shadcn/ui (Radix UI) |
| Database | PostgreSQL (Supabase), Drizzle ORM |
| Vector store | pgvector (default) — or Pinecone |
| LLM & Embeddings | Zhipu AI (default) — or OpenAI |
| File storage | Supabase Storage |
| Auth | NextAuth v5 |
| Rate limiting / cache | Upstash Redis (optional; falls back to in-memory) |
| Logging | pino |
| Deployment | Vercel |

## Prerequisites

- **Node.js 18+** (developed on Node 22)
- A **Supabase** project (provides both PostgreSQL and file storage)
- An LLM API key — **Zhipu AI** (`ZHIPU_API_KEY`) or **OpenAI** (`OPENAI_API_KEY`)

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.local.example .env.local
```

Then fill in `.env.local` (see [Environment Variables](#environment-variables) below). At minimum you need the database, NextAuth, Supabase, and one LLM key.

### 3. Set up the database

Push the schema to your Supabase database:

```bash
npm run db:push
```

`db:push` only creates the tables defined in `drizzle/schema.ts`. The vector column and extensions are **not** part of the schema, so run the following once in the **Supabase SQL Editor**:

```sql
-- Required for vector search
CREATE EXTENSION IF NOT EXISTS vector;
-- Required for fast filename search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Embedding column. 1024 dims for Zhipu (embedding-2); use 1536 for OpenAI.
ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Vector similarity index
CREATE INDEX IF NOT EXISTS document_chunks_embedding_idx
  ON document_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

> If you switch the LLM provider, the embedding dimension must match: **Zhipu = 1024**, **OpenAI = 1536**. Changing it requires recreating the `embedding` column.

### 4. Create the storage bucket

In the Supabase dashboard → **Storage**, create a bucket named **`documents`** (keep it **private**). Uploads fail with “Bucket not found” without it. See [SUPABASE_SETUP.md](SUPABASE_SETUP.md) for details.

### 5. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Environment Variables

### Required

| Variable | Description |
| -------- | ----------- |
| `DATABASE_URL` | PostgreSQL connection string. Use the Supabase **Session pooler** (port 5432) — the app uses prepared statements, which are incompatible with the transaction pooler (6543). |
| `NEXTAUTH_URL` | App URL. `http://localhost:3000` locally; your domain in production. |
| `NEXTAUTH_SECRET` | NextAuth signing secret. Generate with `openssl rand -base64 32`. |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key. |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (server-side only — never expose to the client). |
| `ZHIPU_API_KEY` *or* `OPENAI_API_KEY` | LLM API key for the chosen provider. |

### Optional

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `LLM_PROVIDER` | `zhipu` | `zhipu` or `openai`. |
| `ZHIPU_MODEL` | `glm-4` | e.g. `glm-4.7`, `glm-4-flash`. |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI chat model. |
| `VECTOR_PROVIDER` | `pgvector` | `pgvector` (stored in Postgres) or `pinecone`. |
| `PINECONE_API_KEY`, `PINECONE_INDEX` | — | Only when `VECTOR_PROVIDER=pinecone`. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Google OAuth (optional login method). |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | — | GitHub OAuth (optional login method). |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | — | Rate limiting / cache. Falls back to in-memory if unset (not safe across multiple serverless instances). |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |

## Available Scripts

```bash
npm run dev          # Start the dev server
npm run build        # Production build
npm start            # Run the production build
npm run lint         # ESLint
npm run type-check   # TypeScript type checking

npm run db:push      # Push schema to the database
npm run db:studio    # Open Drizzle Studio
npm run db:migrate   # Run migration files

npm test             # Unit tests
npm run test:integration   # Integration tests
```

## Project Structure

```
src/
├── app/              # App Router pages + API routes (/api/*)
├── components/       # React components (ui, auth, documents, chat, landing, layout, ...)
├── config/           # Runtime config (llm.config, vector.config, ...)
├── hooks/            # Custom React hooks
├── infrastructure/   # LLM & vector repository factories (provider abstraction)
├── lib/              # db, supabase, logger, validators, ...
├── services/         # Business logic (documents: parser/chunking/embedding/storage; rag; ...)
└── types/            # Shared TypeScript types

drizzle/              # Drizzle schema & SQL migrations
scripts/              # Setup / maintenance / verification scripts
docs/                 # Architecture, PRD, stories, deployment guides
```

## Deployment (Vercel)

1. Push the repo to GitHub and import it into [Vercel](https://vercel.com).
2. Add all required environment variables (see above). Remember:
   - `NEXTAUTH_URL` must be your production domain.
   - `NEXT_PUBLIC_*` variables are inlined at **build time** — redeploy after changing them.
   - Use the **Session pooler** connection string for `DATABASE_URL`.
3. Run the one-time **database setup** (pgvector SQL) and **create the `documents` bucket** against the same Supabase project (steps 3–4 above).
4. Deploy.

See [docs/deployment/](docs/deployment/) for the full checklist (database, OAuth, Vercel).

## Documentation

- [QUICK_START.md](QUICK_START.md) — 5-minute setup guide
- [SUPABASE_SETUP.md](SUPABASE_SETUP.md) — storage bucket configuration
- [docs/architecture.md](docs/architecture.md) — architecture overview
- [docs/deployment/](docs/deployment/) — production deployment guides

## License

MIT — see [LICENSE](LICENSE).
