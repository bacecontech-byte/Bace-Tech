-- Pillier — semantic search (RAG) setup. Run once in the Supabase SQL editor.
-- Enables pgvector, creates the chunk store, and a company-scoped match function.

-- 1) Vector extension
create extension if not exists vector;

-- 2) Chunk store: one row per ~1500-char chunk of an incident or document
create table if not exists doc_chunks (
  id           bigserial primary key,
  company_id   text not null,
  source_type  text not null default 'document',   -- 'document' | 'incident'
  source_id    text not null,
  project      text,
  title        text,
  content      text,
  embedding    vector(768),                         -- Gemini text-embedding-004
  created_at   timestamptz default now()
);

create index if not exists doc_chunks_company_idx on doc_chunks (company_id);
create index if not exists doc_chunks_source_idx  on doc_chunks (company_id, source_type, source_id);
-- Approximate nearest-neighbour index (cosine). Rebuild lists as data grows.
create index if not exists doc_chunks_embedding_idx
  on doc_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- 3) Company-scoped similarity search used by /api/rag (action: search)
create or replace function match_chunks(
  query_embedding vector(768),
  match_company   text,
  match_count     int default 6
)
returns table (
  id          bigint,
  source_type text,
  source_id   text,
  project     text,
  title       text,
  content     text,
  similarity  float
)
language sql stable
as $$
  select id, source_type, source_id, project, title, content,
         1 - (embedding <=> query_embedding) as similarity
  from doc_chunks
  where company_id = match_company
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- 4) Security: writes happen only from the server (service-role key), so lock the
-- table down and expose just the search function to the anon/authenticated roles.
alter table doc_chunks enable row level security;   -- no anon policies = no direct client access
grant execute on function match_chunks(vector, text, int) to anon, authenticated;
