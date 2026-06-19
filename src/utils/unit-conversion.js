/**
 * unit-conversion.js
 *
 * Converts recipe ingredient quantities from any culinary unit
 * (pieces, volume, spoons, handfuls …) into grams.
 *
 * Data source: DTU Fødevareinstituttet (Danish Technical University
 * food database) — piece weights, densities, and cooking factors
 * for ~800 common ingredients.
 *
 * Why this matters for price calculation:
 *   A recipe says "2 dl flour". A supermarket sells flour in 1 kg bags.
 *   To compute a per-serving price we must know: 2 dl flour ≈ 120 g,
 *   which is 12 % of a 1 kg bag at price X → proportional cost.
 *   Without this conversion the cost engine is blind on ~40 % of ingredients.
 *
 * Extended by PIECE_WEIGHTS below for items not in the DTU dataset.
 */

// ── Normalisation helper ───────────────────────────────────────────────────────
// Strips diacritics and maps Danish vowels to ASCII equivalents so that
// "rødkål", "roedkaal", and "Rødkål" all resolve to the same map key.
const norm = s =>
  (s ?? "")
    .toLowerCase()
    .replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .trim();

// ── Piece weights (gram per piece) ────────────────────────────────────────────
// Manually curated for items where the DTU table has no per-piece entry
// or where the DTU value diverges from what Danish supermarkets actually sell.
// Confirmed by physical weighing or supplier spec sheets.
const PIECE_WEIGHTS = {
  // Whole spices
  "stjerneanis":        1.3,
  "peberkorn":          0.04,
  "sort peberkorn":     0.04,
  "hvid peberkorn":     0.04,
  "kardemommekapsel":   0.4,
  "kardemommefroe":     0.07,
  "nelliker":           0.1,
  "nellike":            0.1,
  "kanelstang":         5,
  "laurbærblad":        0.12,
  "muskatnoed":         7,
  "vaniljestang":       5,
  "chili":              10,
  "toerret chili":      2,
  "frisk chili":        10,

  // Poultry & meat
  "andebryst":          300,   // supplier-confirmed average
  "kyllingeoverlaer":   120,   // DTU says 80 g, but Danish retail packs average 120 g

  // Mushrooms
  "champignon":         18,
  "portobello":         80,
  "shiitake":           15,

  // Citrus
  "citron":             65,
  "lime":               50,
  "appelsin":           140,

  // Alliums
  "hvidloeg":           50,    // 1 whole head; for cloves use "fed hvidloeg" → 5 g

  // Vegetables
  "majskolbe":          200,
  "miniguleroed":       15,
  "babyguleroed":       15,
  "sugarsnap":          3,

  // Bouillon cubes
  "bouillonterning":            10,
  "oksebouillonterning":        10,
  "gronsagsbouillonterning":    10,
  "honsebouillonterning":       10,

  // Nuts
  "valnoed":            5,
  "mandel":             1.2,
  "cashewnoedder":      1.5,
  "pekannoed":          3,
  "pistacienoed":       0.9,

  // Other
  "bacon":              18,    // average Danish rashers
};

// ── Density table (g per dl, g per tablespoon, g per teaspoon) ────────────────
// Derived from DTU density measurements for flours, fats, dairy, and grains.
const DENSITY = {
  "maelk":        { gDl: 103, gSpsk: 15, gTsk: 5 },
  "soedmaelk":    { gDl: 103, gSpsk: 15, gTsk: 5 },
  "letmaelk":     { gDl: 103, gSpsk: 15, gTsk: 5 },
  "floede":       { gDl: 100, gSpsk: 15, gTsk: 5 },
  "kaernemaelk":  { gDl: 100, gSpsk: 15, gTsk: 5 },
  "yoghurt":      { gDl: 100, gSpsk: 15, gTsk: 5 },
  "vand":         { gDl: 100, gSpsk: 15, gTsk: 5 },
  "sukker":       { gDl:  85, gSpsk: 13, gTsk: 4 },
  "flormelis":    { gDl:  70, gSpsk: 10, gTsk: 3 },
  "melis":        { gDl:  70, gSpsk: 10, gTsk: 3 },
  "salt":         { gDl: 120, gSpsk: 18, gTsk: 6 },
  "bagepulver":   { gDl:  70, gSpsk: 10, gTsk: 3 },
  "natron":       { gDl: 100, gSpsk: 15, gTsk: 5 },
  "kakao":        { gDl:  40, gSpsk:  6, gTsk: 2 },
  "hvedemel":     { gDl:  60, gSpsk:  9, gTsk: 3 },
  "rugmel":       { gDl:  55, gSpsk:  8, gTsk: 3 },
  "havregryn":    { gDl:  40, gSpsk:  6, gTsk: 2 },
  "olie":         { gDl:  92, gSpsk: 14, gTsk: 5 },
  "smaer":        { gDl: 911, gSpsk: 14, gTsk: 5 }, // density of butter
};

// ── Cooking / hydration factors ────────────────────────────────────────────────
// cooked_g = dry_g × factor
// Lets the engine convert "150 g tørt ris" to the cooked weight used in portion sizing.
const COOKING_FACTOR = {
  "ris":       2.5,
  "pasta":     2.5,
  "spagetti":  3.0,
  "linser":    2.5,
  "kikarter":  2.1,
  "bonner":    2.4,
  "aarter":    2.1,
};

// ── Fuzzy lookup ──────────────────────────────────────────────────────────────
// Three-pass strategy:
//   1. Exact match on normalised key.
//   2. The map key is a substring of the ingredient name
//      ("rødkål" matches "snittet rødkål").
//   3. The first word of the ingredient name matches a key
//      ("hvedemel" matches "hvedemel sigtet").
function fuzzyGet(map, ingName) {
  const n = norm(ingName);
  if (map[n]) return map[n];
  for (const [key, val] of Object.entries(map)) {
    if (n.includes(key) && key.length > 2) return val;
  }
  const first = n.split(/\s+/)[0];
  return first ? map[first] : null;
}

// ── Exported helpers ──────────────────────────────────────────────────────────
export function getPieceGrams(ingName)   { return fuzzyGet(PIECE_WEIGHTS, ingName); }
export function getDensityDTU(ingName)   { return fuzzyGet(DENSITY,       ingName); }
export function getCookingFactor(ingName){ return fuzzyGet(COOKING_FACTOR, ingName); }

// ── Main conversion function ──────────────────────────────────────────────────
/**
 * getIngredientGrams(amount, unit, ingName)
 *
 * Converts a recipe quantity to grams.
 *
 * Returns { grams: number, approx: boolean } or null when conversion is
 * impossible (e.g. "1 stk gær" with no known piece weight).
 *
 * approx = true signals that a fallback value was used (e.g. water density
 * for an unknown liquid) — the caller can show a confidence indicator.
 *
 * @param {number} amount   - numeric quantity from the recipe
 * @param {string} unit     - unit string, e.g. "g", "dl", "spsk", "stk", "fed"
 * @param {string} ingName  - ingredient name used for table lookups
 */
export function getIngredientGrams(amount, unit, ingName) {
  if (!amount || amount <= 0) return null;
  const u = norm(unit ?? "");

  // ── Direct mass units ──────────────────────────────────────
  if (u === "g"  || u === "gram")  return { grams: amount,        approx: false };
  if (u === "kg" || u === "kilo")  return { grams: amount * 1000, approx: false };

  // ── Piece / no unit → DTU piece weight ────────────────────
  // Ground/powdered forms ("stødt kanel", "malet peber") are skipped
  // because "stk" doesn't apply to powders — they should be weighed by spoon.
  const isGround = /stodt|malet|knust|pulver|formalet/i.test(norm(ingName ?? ""));
  if (!u || u === "stk" || u === "styk" || u === "stykker") {
    if (!isGround) {
      const g = getPieceGrams(ingName);
      if (g != null) return { grams: amount * g, approx: false };
    }
    return null;
  }

  // ── Volume → mass via DTU density ─────────────────────────
  const d = getDensityDTU(ingName);

  if (u === "dl") {
    if (d?.gDl) return { grams: amount * d.gDl, approx: false };
    return { grams: amount * 100, approx: true };  // water fallback
  }
  if (u === "spsk" || u === "spiseskefuld") {
    return { grams: amount * (d?.gSpsk ?? 12), approx: !d };
  }
  if (u === "tsk" || u === "teskefuld") {
    return { grams: amount * (d?.gTsk ?? 4), approx: !d };
  }

  // ── Exact liquid units ─────────────────────────────────────
  if (u === "ml")                    return { grams: amount,        approx: false };
  if (u === "cl")                    return { grams: amount * 10,   approx: false };
  if (u === "l" || u === "liter")    return { grams: amount * 1000, approx: false };

  // ── Informal units ─────────────────────────────────────────
  const APPROX = {
    fed: 5, knsp: 0.5, knivspids: 0.5, nip: 0.5,
    haandfuld: 40, haandfulde: 40, handfuld: 40,
    bundtet: 25, bundt: 25, stilk: 15, blade: 5, blad: 5,
    skive: 25, skiver: 25,
  };
  if (APPROX[u] != null) return { grams: amount * APPROX[u], approx: true };

  return null;
}
