-- ============================================================
-- Grocery Intelligence Pipeline — Core Schema
-- SQLite / Cloudflare D1
-- ============================================================

-- ── 1. Canonical ingredient registry ─────────────────────────
-- Single source of truth for every ingredient name.
-- All store products map INTO this namespace via aliases and
-- the match engine — never the other way around.
CREATE TABLE IF NOT EXISTS ingredients_master (
  name              TEXT PRIMARY KEY,   -- canonical name, lowercase, e.g. "smør"
  normal_price      REAL,               -- reference price per unit (used in cost calc)
  unit              TEXT,               -- "g" | "ml" | "stk"
  bilka_prod_id     TEXT,               -- manually verified Bilka object_id
  rema_prod_id      TEXT,               -- manually verified Rema object_id
  foetex_ean        TEXT,               -- Føtex EAN (cross-enriched)
  netto_ean         TEXT,               -- Netto EAN
  frida_id          TEXT,               -- DTU food database ID (nutrition link)
  climate_id        TEXT,               -- CONCITO CO2e footprint link
  allergen_maelk    INTEGER DEFAULT 0,
  allergen_gluten   INTEGER DEFAULT 0,
  allergen_fisk     INTEGER DEFAULT 0,
  allergen_aeg      INTEGER DEFAULT 0,
  allergen_noedder  INTEGER DEFAULT 0,
  parent_ingredient TEXT,               -- taxonomy parent (e.g. "kyllingebryst" → "kylling")
  department        TEXT,               -- store department anchor ("Mejeri", "Kød", …)
  buy_preference    TEXT,               -- "bilka" | "rema" | "foetex" | null (user default)
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 2. Alias bridge ───────────────────────────────────────────
-- Normalises spelling variants, brand names, and recipe
-- shorthand to their canonical ingredient.
-- Direction is strictly one-way: alias → canonical.
CREATE TABLE IF NOT EXISTS ingredient_aliases (
  alias     TEXT PRIMARY KEY,           -- e.g. "cremefraiche", "Arla Kærgården"
  canonical TEXT NOT NULL               -- → "creme fraiche", "smør"
);

-- ── 3. Multi-store product catalogue ─────────────────────────
-- Every product from every integrated store lands here with a
-- unified schema. Store-specific quirks are normalised on import.
CREATE TABLE IF NOT EXISTS products_catalog (
  id                  TEXT PRIMARY KEY,  -- "{store}:{objectID}"
  store               TEXT NOT NULL,     -- "bilka" | "rema" | "foetex" | "netto" | "nemlig"
  object_id           TEXT NOT NULL,
  ean                 TEXT,
  name                TEXT NOT NULL,
  brand               TEXT,
  category            TEXT,              -- store's own leaf category label
  department          TEXT,              -- store's own top-level department label
  category_path       TEXT,              -- full hierarchy string, root → leaf, " / "-separated
                                         -- Bilka: "Kolonial / Krydderier / Paprika pulver"
                                         -- Rema/Føtex: null (flat category only)
  ingredient_type     TEXT,              -- culinary classification via inferProductType()
                                         -- "krydderi"|"grøntsag"|"protein"|"mejeri"|"korn"|
                                         -- "fedt"|"nødder"|"sauce"|"frugt"|"andet" | null
  price               REAL,
  unit_price          REAL,
  price_unit          TEXT,              -- "kg" | "L" | "stk"
  is_on_discount      INTEGER DEFAULT 0,
  is_organic          INTEGER DEFAULT 0,
  contents            REAL,
  contents_unit       TEXT,
  image_url           TEXT,
  storage_temp_max    REAL,             -- °C ceiling; ≤ 5 = cold chain product
  search_words        TEXT,             -- JSON array — store synonyms used in matching
  canonical_ingredient TEXT,            -- FK → ingredients_master.name (set by match engine)
  updated_at          TEXT DEFAULT (datetime('now')),

  UNIQUE(store, object_id)
);

CREATE INDEX IF NOT EXISTS idx_pc_ean            ON products_catalog(ean)             WHERE ean IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pc_store          ON products_catalog(store);
CREATE INDEX IF NOT EXISTS idx_pc_canonical      ON products_catalog(canonical_ingredient) WHERE canonical_ingredient IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pc_unmatched      ON products_catalog(store, id)       WHERE canonical_ingredient IS NULL;
CREATE INDEX IF NOT EXISTS idx_pc_ingredient_type ON products_catalog(ingredient_type) WHERE ingredient_type IS NOT NULL;

-- ── 4. EAN cross-reference map ────────────────────────────────
-- One product can carry multiple EANs (pack sizes, private-label
-- re-brands). This table makes cross-store price comparison
-- possible even when the primary EAN field diverges.
CREATE TABLE IF NOT EXISTS product_ean_map (
  product_id  TEXT NOT NULL,            -- products_catalog.id
  ean         TEXT NOT NULL,
  PRIMARY KEY (product_id, ean)
);

CREATE INDEX IF NOT EXISTS idx_pem_ean ON product_ean_map(ean);

-- ── 5. Cross-store product alias (size variants / re-brands) ──
CREATE TABLE IF NOT EXISTS product_id_aliases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  TEXT NOT NULL,            -- canonical product
  alias_id    TEXT NOT NULL,            -- equivalent product in another store or pack size
  alias_type  TEXT NOT NULL DEFAULT 'cross-store'  -- "cross-store" | "size-variant"
);

-- ── 6. Cross-store taxonomy ───────────────────────────────────
-- Maps each store's own category labels to a shared taxonomy
-- node. Used by the match engine as a tier-1 signal: if ≥ 3
-- stores agree that a product belongs to node X, that agreement
-- overrides a missing local category rule.
CREATE TABLE IF NOT EXISTS taxonomy_nodes (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,            -- e.g. "Mejeri", "Kød & Fjerkræ"
  parent_id   INTEGER REFERENCES taxonomy_nodes(id)
);

CREATE TABLE IF NOT EXISTS store_category_map (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store          TEXT NOT NULL,
  store_category TEXT NOT NULL,         -- the raw label from that store's API
  node_id        INTEGER NOT NULL REFERENCES taxonomy_nodes(id),
  UNIQUE(store, store_category)
);

-- ── 7. Deterministic match rules ─────────────────────────────
-- Each rule says: "if a product name contains <include_token>
-- (respecting compound-word semantics) and its category is in
-- <categories>, write <canonical> as the match."
-- Rules are generated by the pipeline and approved by a human
-- before activation (active = 1).
CREATE TABLE IF NOT EXISTS ingredient_match_rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical      TEXT NOT NULL,                     -- → ingredients_master.name
  include_token  TEXT NOT NULL,                     -- word or phrase to match
  mode           TEXT NOT NULL DEFAULT 'word',      -- "word" | "phrase"
  exclude_tokens TEXT,                              -- comma-separated disqualifiers
  categories     TEXT NOT NULL DEFAULT '[]',        -- JSON array of store category labels
  store          TEXT,                              -- null = all stores, else "bilka" | "rema" …
  active         INTEGER NOT NULL DEFAULT 0,        -- 0 = pending review, 1 = live
  source         TEXT DEFAULT 'generated',          -- "generated" | "manual"
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_imr_canonical ON ingredient_match_rules(canonical);
CREATE INDEX IF NOT EXISTS idx_imr_active    ON ingredient_match_rules(active) WHERE active = 1;

-- ── 8. Per-ingredient type constraints ───────────────────────
-- Guards against cross-type matches (e.g. "mælk" as liquid must
-- not match "mælkechokolade" in the confectionery aisle).
CREATE TABLE IF NOT EXISTS ingredient_type_rules (
  canonical       TEXT PRIMARY KEY,
  type            TEXT,                -- "mass" | "vol" | "stk"
  forbidden_words TEXT,                -- comma-sep; any hit disqualifies a candidate
  required_words  TEXT,                -- comma-sep; at least one must appear (empty = no constraint)
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 9. Match engine output — auto-classification ─────────────
CREATE TABLE IF NOT EXISTS product_canonical_map (
  product_id    TEXT NOT NULL,          -- products_catalog.id
  canonical     TEXT NOT NULL,          -- ingredients_master.name
  score         REAL NOT NULL,          -- TF-IDF confidence score
  method        TEXT DEFAULT 'tokens',  -- "tokens" | "embedding" | "manual"
  classified_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (product_id, canonical)
);

CREATE INDEX IF NOT EXISTS idx_pcm_canonical ON product_canonical_map(canonical, score DESC);
CREATE INDEX IF NOT EXISTS idx_pcm_product   ON product_canonical_map(product_id);

-- ── 10. Human-in-the-Loop review queue ───────────────────────
-- Tier-2 matches (ambiguous or low-confidence) land here for
-- human approval before being committed to products_catalog.
CREATE TABLE IF NOT EXISTS ai_match_queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_name TEXT NOT NULL,
  store           TEXT NOT NULL,
  object_id       TEXT NOT NULL,
  product_name    TEXT,
  confidence      REAL DEFAULT 0.6,
  match_type      TEXT DEFAULT 'smart_link',  -- "smart_link" | "embedding" | "ai"
  status          TEXT DEFAULT 'pending',     -- "pending" | "approved" | "rejected"
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(ingredient_name, store, object_id)
);

-- ── 11. Alias review queue ────────────────────────────────────
-- Pipeline-generated alias suggestions awaiting admin sign-off.
-- Prevents bulk-write errors (the "Pepsi → bacon" class of bug).
CREATE TABLE IF NOT EXISTS alias_review_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  alias        TEXT NOT NULL,
  canonical    TEXT NOT NULL,
  source       TEXT DEFAULT 'pipeline',
  status       TEXT DEFAULT 'pending',  -- "pending" | "approved" | "rejected"
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(alias, canonical)
);

-- ── 12. TF-IDF learned token weights ─────────────────────────
-- Trained from the full product corpus; used by the embedding
-- fallback path and the token-scoring pipeline stage.
CREATE TABLE IF NOT EXISTS ingredient_match_tokens (
  canonical    TEXT NOT NULL,
  token        TEXT NOT NULL,
  weight       REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (canonical, token)
);

CREATE INDEX IF NOT EXISTS idx_imt_canonical ON ingredient_match_tokens(canonical);

-- ── 13. Vector embeddings (bge-m3 / 1024 dims) ───────────────
CREATE TABLE IF NOT EXISTS ingredient_embeddings (
  name         TEXT PRIMARY KEY,        -- = ingredients_master.name
  embedding    TEXT NOT NULL,           -- JSON float array
  updated_at   TEXT DEFAULT (datetime('now'))
);

-- ── 14. Manually verified product links ──────────────────────
-- Highest-priority price source: a human has confirmed exactly
-- which store product to use for a given ingredient.
CREATE TABLE IF NOT EXISTS ingredient_catalog_links (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_name TEXT NOT NULL,
  store           TEXT NOT NULL,
  object_id       TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(ingredient_name, store, object_id)
);

-- ── 15. Permanently dismissed pairs ──────────────────────────
-- Once a product–ingredient pair is rejected, the engine never
-- re-proposes it. Prevents pipeline churn on confirmed negatives.
CREATE TABLE IF NOT EXISTS catalog_coverage_ignored (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_name TEXT,
  product_id      TEXT NOT NULL,
  UNIQUE(product_id, ingredient_name)
);

-- ── 16. Price history ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_price_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    TEXT NOT NULL,
  normal_price  REAL,
  sale_price    REAL,
  is_on_discount INTEGER DEFAULT 0,
  recorded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pph_product ON product_price_history(product_id, recorded_at DESC);
