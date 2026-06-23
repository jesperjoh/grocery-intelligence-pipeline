/**
 * match-engine.js
 *
 * Cloudflare Worker - deterministic ingredient–product matching.
 *
 * Problem: Danish supermarket catalogues are structurally noisy.
 * "Yoghurt" returns strawberry smoothies. "Tun" returns tuna salad.
 * "Smør" returns butter-flavoured spread. Substring search is useless.
 *
 * Solution: a two-tier rule engine that combines token semantics,
 * cross-store taxonomy voting, and physical signals (cold chain,
 * department consensus) to write high-confidence matches directly
 * and route ambiguous cases to a Human-in-the-Loop review queue.
 *
 * Cloudflare bindings expected in `env`:
 *   env.DB   - D1 (SQLite) database
 *
 * No real API keys are present in this file.
 * Deploy secrets via:  wrangler secret put <KEY>
 */

// ── Token helpers ──────────────────────────────────────────────────────────────
// Splits a product name into lowercase word tokens, treating all
// non-alphanumeric characters (including Danish æøå) as separators.
function ruleWords(s) {
  return (s || "").toLowerCase().split(/[^0-9a-zæøåüöéèêàâôîïûäß]+/).filter(Boolean);
}

/**
 * ruleTokenMatches(name, token, mode)
 *
 * Returns true when `token` is present in `name` according to `mode`.
 *
 * mode = "word"   (default)
 *   Matches a whole word OR a compound-word suffix.
 *   Danish nouns are formed by compounding - the head noun always comes
 *   last, so "ketchup" correctly matches "tomatketchup", while "tun" does
 *   NOT match "tunsalat" (which is a prepared dish, not raw tuna).
 *   Short tokens (< 4 chars) are only matched as whole words, with one
 *   deliberate exception: "æg" (egg) is a genuine compound head and must
 *   match "skrabeæg", "frilandsæg", "æggehvide", etc.
 *
 * mode = "phrase"
 *   Case-insensitive substring; also checks the compacted form (no spaces)
 *   to handle store inconsistencies like "creme fraiche" vs "cremefraiche".
 */
function ruleTokenMatches(name, token, mode) {
  if (mode === "phrase") {
    const nl = (name || "").toLowerCase();
    return nl.includes(token) || nl.replace(/ /g, "").includes(token.replace(/ /g, ""));
  }
  // word mode
  const ws = ruleWords(name);
  if (token.length < 4 && token !== "æg") return ws.includes(token);
  return ws.some(w => w === token || w.endsWith(token));
}

// ── Main matching function ─────────────────────────────────────────────────────
/**
 * applyMatchRules(env, options)
 *
 * Scans up to `limit` unmatched products and attempts to assign each one
 * a canonical ingredient using the active ruleset in `ingredient_match_rules`.
 *
 * Tier classification:
 *   Tier 1 - high confidence, written immediately to `canonical_ingredient`
 *             Conditions: token hit + at least one of:
 *               • product category is in rule's allowed category set
 *               • ≥ 3 distinct stores vote for the same taxonomy node (cross-store consensus)
 *             None of the following disqualifiers may fire:
 *               • department mismatch  (≥ 60 % of confirmed products live in a different dept)
 *               • cold-chain mismatch  (ingredient is refrigerated but product is ambient)
 *               • prepared-product mismatch (røget/kogt/grillet/paneret vs. raw ingredient)
 *               • compound-word mismatch  (e.g. "jordbæryoghurt" cannot match "jordbær")
 *
 *   Tier 2 - possible match, routed to `ai_match_queue` for human review
 *             Token hit, but one or more tier-1 guards failed.
 *             Only written when options.queueTier2 = true.
 *
 * Permanently dismissed product–ingredient pairs (catalog_coverage_ignored) are
 * skipped and will never be re-proposed by this engine.
 *
 * @param {object} env          - Cloudflare Worker environment bindings
 * @param {object} [options]
 * @param {number} [options.limit=2000]       - max products to scan per run
 * @param {string} [options.store]            - restrict to one store (null = all)
 * @param {boolean} [options.dryRun=false]    - compute only, write nothing
 * @param {boolean} [options.queueTier2=false]- whether to persist tier-2 suggestions
 * @returns {object} run statistics
 */
async function applyMatchRules(env, { limit = 2000, store = null, dryRun = false, queueTier2 = false } = {}) {

  // ── Load active rules ──────────────────────────────────────────────────────
  const { results: ruleRows } = await env.DB.prepare(
    `SELECT canonical, include_token, mode, exclude_tokens, categories, store
     FROM ingredient_match_rules WHERE active = 1`
  ).all();
  if (!ruleRows?.length) return { ok: true, rules: 0, note: "no active rules" };

  const rules = ruleRows.map(r => ({
    canonical: r.canonical,
    token:     r.include_token,
    mode:      r.mode || "word",
    store:     r.store,
    excludes:  (r.exclude_tokens || "").split(",").map(s => s.trim()).filter(Boolean),
    catSet:    new Set(JSON.parse(r.categories || "[]")),
  }));

  // ── Load permanently dismissed pairs ──────────────────────────────────────
  const { results: ignoredRows } = await env.DB.prepare(
    `SELECT product_id, ingredient_name FROM catalog_coverage_ignored WHERE ingredient_name IS NOT NULL`
  ).all().catch(() => ({ results: [] }));
  const ignoredPairs = new Set((ignoredRows ?? []).map(r => `${r.product_id}:${r.ingredient_name}`));

  // ── Build cross-store taxonomy lookup ─────────────────────────────────────
  // store_category_map translates each store's own category label into a
  // shared taxonomy node_id. When the same node is confirmed by ≥ 3 distinct
  // stores for a given canonical, it acts as a tier-1 pass even if the local
  // category rule does not list that store's label.
  const { results: scmRows } = await env.DB.prepare(
    `SELECT store, store_category, node_id FROM store_category_map`
  ).all().catch(() => ({ results: [] }));

  const scm = {}; // { store: { category: node_id } }
  for (const row of (scmRows ?? [])) {
    if (!scm[row.store]) scm[row.store] = {};
    scm[row.store][row.store_category] = row.node_id;
  }

  // ── Compute consensus signals per canonical ────────────────────────────────
  // We look at products that are ALREADY confirmed (via manual links or a
  // previous canonical_ingredient write) and derive three signals:
  //
  //   deptConsensus  - if ≥ 3 confirmed products are in the same department AND
  //                    that department covers ≥ 60 % of all confirmed products,
  //                    a candidate from a different department is demoted to tier 2.
  //
  //   coldChainSet   - if ≥ 2 confirmed products have storage_temp_max ≤ 5 °C,
  //                    an ambient candidate (temp > 10 °C) is demoted to tier 2.
  //
  //   crossStoreTax  - taxonomy node that ≥ 3 distinct stores agree on for this
  //                    canonical. Used as the cross-store tier-1 gate.

  const canonicals   = [...new Set(rules.map(r => r.canonical))];
  const deptConsensus  = {};  // canonical → { dept, count, total }
  const coldChainSet   = new Set();
  const crossStoreTax  = {};  // canonical → node_id

  // D1 has a 100-parameter limit per query; chunk in batches of 90.
  for (let ci = 0; ci < canonicals.length; ci += 90) {
    const chunk = canonicals.slice(ci, ci + 90);
    const ph = chunk.map(() => "?").join(",");

    // Department distribution from auto-matched products
    const { results: r1 } = await env.DB.prepare(
      `SELECT canonical_ingredient AS c, department AS d, COUNT(*) AS n
       FROM products_catalog
       WHERE canonical_ingredient IN (${ph}) AND department IS NOT NULL AND department != ''
       GROUP BY canonical_ingredient, department`
    ).bind(...chunk).all().catch(() => ({ results: [] }));

    // Department distribution from manually verified links
    const { results: r2 } = await env.DB.prepare(
      `SELECT icl.ingredient_name AS c, pc.department AS d, COUNT(*) AS n
       FROM ingredient_catalog_links icl
       JOIN products_catalog pc ON pc.store = icl.store AND pc.object_id = icl.object_id
       WHERE icl.ingredient_name IN (${ph}) AND pc.department IS NOT NULL AND pc.department != ''
       GROUP BY icl.ingredient_name, pc.department`
    ).bind(...chunk).all().catch(() => ({ results: [] }));

    // Accumulate department totals
    const deptTotals = {};
    for (const row of [...(r1 ?? []), ...(r2 ?? [])]) {
      if (!deptTotals[row.c]) deptTotals[row.c] = {};
      deptTotals[row.c][row.d] = (deptTotals[row.c][row.d] ?? 0) + row.n;
    }
    for (const [canonical, deptCounts] of Object.entries(deptTotals)) {
      const entries = Object.entries(deptCounts).sort((a, b) => b[1] - a[1]);
      const total   = entries.reduce((s, [, c]) => s + c, 0);
      const [topDept, topCount] = entries[0];
      if (topCount >= 3 && topCount / total >= 0.6)
        deptConsensus[canonical] = { dept: topDept, count: topCount, total };
    }

    // Cold-chain: count confirmed products with refrigerated storage
    const { results: rc1 } = await env.DB.prepare(
      `SELECT canonical_ingredient AS c, COUNT(*) AS n
       FROM products_catalog
       WHERE canonical_ingredient IN (${ph}) AND storage_temp_max IS NOT NULL AND storage_temp_max <= 5
       GROUP BY canonical_ingredient`
    ).bind(...chunk).all().catch(() => ({ results: [] }));
    const { results: rc2 } = await env.DB.prepare(
      `SELECT icl.ingredient_name AS c, COUNT(*) AS n
       FROM ingredient_catalog_links icl
       JOIN products_catalog pc ON pc.store = icl.store AND pc.object_id = icl.object_id
       WHERE icl.ingredient_name IN (${ph}) AND pc.storage_temp_max IS NOT NULL AND pc.storage_temp_max <= 5
       GROUP BY icl.ingredient_name`
    ).bind(...chunk).all().catch(() => ({ results: [] }));

    const coldCounts = {};
    for (const row of [...(rc1 ?? []), ...(rc2 ?? [])])
      coldCounts[row.c] = (coldCounts[row.c] ?? 0) + row.n;
    for (const [canonical, n] of Object.entries(coldCounts))
      if (n >= 2) coldChainSet.add(canonical);

    // Cross-store taxonomy vote
    const { results: tv1 } = await env.DB.prepare(
      `SELECT canonical_ingredient AS c, store, category FROM products_catalog
       WHERE canonical_ingredient IN (${ph}) AND category IS NOT NULL AND category != ''`
    ).bind(...chunk).all().catch(() => ({ results: [] }));
    const { results: tv2 } = await env.DB.prepare(
      `SELECT icl.ingredient_name AS c, pc.store, pc.category
       FROM ingredient_catalog_links icl
       JOIN products_catalog pc ON pc.store = icl.store AND pc.object_id = icl.object_id
       WHERE icl.ingredient_name IN (${ph}) AND pc.category IS NOT NULL AND pc.category != ''`
    ).bind(...chunk).all().catch(() => ({ results: [] }));

    const chunkVotes = {}; // canonical → { nodeId → Set<store> }
    for (const row of [...(tv1 ?? []), ...(tv2 ?? [])]) {
      const nodeId = scm[row.store]?.[row.category];
      if (!nodeId) continue;
      if (!chunkVotes[row.c])           chunkVotes[row.c] = {};
      if (!chunkVotes[row.c][nodeId])   chunkVotes[row.c][nodeId] = new Set();
      chunkVotes[row.c][nodeId].add(row.store);
    }
    for (const [canonical, nodeVotes] of Object.entries(chunkVotes)) {
      let bestNode = null, bestCount = 0;
      for (const [nodeId, stores] of Object.entries(nodeVotes)) {
        if (stores.size >= 3 && stores.size > bestCount) {
          bestNode = parseInt(nodeId); bestCount = stores.size;
        }
      }
      if (bestNode) crossStoreTax[canonical] = bestNode;
    }
  }

  // ── Load unmatched products ────────────────────────────────────────────────
  const { results: products } = await env.DB.prepare(`
    SELECT id, store, object_id, name, category, department, storage_temp_max, search_words
    FROM products_catalog
    WHERE canonical_ingredient IS NULL AND name IS NOT NULL AND name != ''
    ${store ? "AND store = ?" : ""}
    ORDER BY RANDOM() LIMIT ?
  `).bind(...(store ? [store, limit] : [limit])).all();

  // ── Disqualifier patterns ──────────────────────────────────────────────────

  // "Prepared product" - if the product name signals cooking/processing and
  // the rule's canonical does not, demote to tier 2.
  // A raw ingredient rule should not match "røget laks" or "panerede kyllingestrimler".
  const PREPARED_RE = /\b(røget|kogt|stegt|grillet|tilberedt|ovnklar|sous[\s-]?vide|paneret|pulled|sprængt|lufttørret)\b/i;

  // "Compound ingredient" - the ingredient is only a component in this product.
  // Examples: jordbæryoghurt contains jordbær but IS NOT jordbær.
  //           sardiner i olie contains olie but IS NOT olie.
  // Exception: if the canonical itself contains the compound word
  //   (e.g. canonical = "yoghurt" → yoghurt products ARE valid matches).
  const COMPOUND_WORDS   = ["yoghurt","skyr","kefir","drikkeyoghurt","marmelade",
                            "syltetøj","kompot","smoothie","juice","dressing",
                            "grød","müsli","granola","smag","aroma"];
  const COMPOUND_PHRASES = [" i olie"," i lage"," i saltlage"," i marinade"," i tomat"];

  // ── Classify each product ─────────────────────────────────────────────────
  let tier1 = 0, tier2 = 0, ambiguous = 0;
  const updates    = [];
  const queueStmts = [];

  for (const p of (products ?? [])) {
    const cat = p.category || "";

    // Include the store's own search synonyms in the match surface
    let matchText = p.name;
    if (p.search_words) {
      try { matchText += " " + JSON.parse(p.search_words).join(" "); } catch {}
    }

    const hits = [];

    for (const r of rules) {
      if (r.store && r.store !== p.store) continue;
      if (!ruleTokenMatches(matchText, r.token, r.mode)) continue;
      if (r.excludes.some(x => ruleTokenMatches(matchText, x, "word"))) continue;

      // ── Tier guards ──────────────────────────────────────────
      const consensus     = deptConsensus[r.canonical];
      const deptMismatch  = consensus && p.department && p.department !== consensus.dept;

      const tempMismatch  = coldChainSet.has(r.canonical)
                            && p.storage_temp_max != null
                            && p.storage_temp_max > 10;

      const preparedMismatch = PREPARED_RE.test(p.name) && !PREPARED_RE.test(r.canonical);

      const pLow = p.name.toLowerCase();
      const cLow = r.canonical.toLowerCase();
      const compoundMismatch =
        COMPOUND_WORDS.some(w  => pLow.includes(w)      && !cLow.includes(w)) ||
        COMPOUND_PHRASES.some(ph => pLow.includes(ph)   && !cLow.includes(ph.trim()));

      // Cross-store taxonomy: alternate tier-1 path
      const productNodeId = scm[p.store]?.[p.category];
      const crossStoreOk  = !!(productNodeId && crossStoreTax[r.canonical] === productNodeId);

      const catOk = (cat && r.catSet.has(cat)) || crossStoreOk;

      const tier = (catOk && !deptMismatch && !tempMismatch && !preparedMismatch && !compoundMismatch)
        ? 1 : 2;

      hits.push({ r, tier });
    }

    if (!hits.length) continue;

    // Prefer tier 1 over tier 2; within the same tier prefer longer (more specific) tokens.
    hits.sort((a, b) => a.tier - b.tier || b.r.token.length - a.r.token.length);
    const best     = hits[0];
    const sameRank = hits.filter(h => h.tier === best.tier && h.r.token.length === best.r.token.length);

    // Ambiguous: multiple distinct canonicals at the same confidence - skip.
    if (new Set(sameRank.map(h => h.r.canonical)).size > 1) { ambiguous++; continue; }

    // Skip permanently dismissed pairs
    if (ignoredPairs.has(`${p.id}:${best.r.canonical}`)) continue;

    if (best.tier === 1) {
      tier1++;
      if (!dryRun) updates.push(
        env.DB.prepare(
          `UPDATE products_catalog SET canonical_ingredient = ? WHERE id = ? AND canonical_ingredient IS NULL`
        ).bind(best.r.canonical, p.id)
      );
    } else if (queueTier2) {
      tier2++;
      if (!dryRun) queueStmts.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO ai_match_queue
             (ingredient_name, store, object_id, product_name, confidence, match_type)
           VALUES (?, ?, ?, ?, 0.6, 'smart_link')`
        ).bind(best.r.canonical, p.store, p.object_id, p.name)
      );
    }
  }

  // Batch writes in groups of 50 to stay within D1 transaction limits
  if (!dryRun) {
    for (let i = 0; i < updates.length;    i += 50) await env.DB.batch(updates.slice(i, i + 50));
    for (let i = 0; i < queueStmts.length; i += 50) await env.DB.batch(queueStmts.slice(i, i + 50));
  }

  return {
    ok:            true,
    dry_run:       dryRun,
    rules:         rules.length,
    scanned:       products?.length ?? 0,
    tier1_applied: tier1,
    tier2_queued:  tier2,
    ambiguous,
    done:          (products?.length ?? 0) < limit,
  };
}

// ── Cloudflare Worker entry point ─────────────────────────────────────────────
export default {
  // HTTP handler - exposes the engine as a REST endpoint for manual runs
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/apply-match-rules") {
      const body       = await request.json().catch(() => ({}));
      const dryRun     = body.dry_run   ?? url.searchParams.has("dry");
      const queueTier2 = body.queue     ?? url.searchParams.has("queue");
      const limit      = parseInt(body.limit ?? url.searchParams.get("limit") ?? "2000", 10);
      const store      = body.store     ?? url.searchParams.get("store") ?? null;

      const result = await applyMatchRules(env, { limit, store, dryRun, queueTier2 });
      return Response.json(result);
    }

    return new Response("grocery-intelligence-pipeline", { status: 200 });
  },

  // Scheduled handler - runs daily via cron (see wrangler.toml.example)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(applyMatchRules(env, { limit: 2000 }));
  },
};
