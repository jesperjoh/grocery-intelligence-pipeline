/**
 * ingredient-type.js
 *
 * Classifies a store product into one of ten culinary ingredient types
 * based on the store's own category and department labels.
 *
 * Problem: Danish supermarkets organise their shelves by retail logic,
 * not culinary logic. A recipe for "paprika" might mean the spice
 * (kroket, 80 g tin) or the vegetable (rød peberfrugt, 300 g). A
 * simple name search returns both — and the wrong one inflates the
 * estimated recipe cost by 10–15×.
 *
 * Solution: use the store's own category hierarchy as a classification
 * signal. Every store exposes some form of category tree; mapping it to
 * a shared culinary type narrows candidates before any name matching
 * happens, so the match engine only competes products of the same
 * culinary class against each other.
 *
 * Supported stores
 * ────────────────
 *   bilka   — category_path:  "Kolonial / Konserves, bouillon & krydderier / Krydderier"
 *   rema    — category + department from category_name / department_name fields
 *   foetex  — category + department derived from breadcrumb array
 *   netto   — same schema as Føtex (shared Salling Group backend)
 *   nemlig  — flat category label (less structured than Bilka/Føtex)
 *
 * Usage
 * ─────
 *   import { inferProductType } from './classifiers/ingredient-type.js';
 *   const type = inferProductType(product.category_path, product.category, product.department);
 *   // → "krydderi" | "grøntsag" | "protein" | … | null
 *
 * The function returns null when no rule matches, leaving the field
 * unset for a later AI-assisted classification pass.
 */

// ── Output types ──────────────────────────────────────────────────────────────
//
//   krydderi  — spices, dried herbs, salt, pepper, vanilla
//   grøntsag  — vegetables (fresh, frozen, or tinned)
//   frugt     — fruits, berries, citrus
//   protein   — meat, poultry, fish, shellfish, eggs, legumes, tofu
//   mejeri    — dairy: milk, cream, yoghurt, cheese, butter
//   korn      — grains, pasta, rice, flour, bread, oats
//   fedt      — cooking oils and pure fats
//   nødder    — nuts, seeds, nut pastes
//   sauce     — condiments, stocks, tinned tomatoes, jams, syrups
//   andet     — beverages, confectionery, cleaning products, non-food

// ── Rule table ────────────────────────────────────────────────────────────────
//
// Rules are tested in array order. First match wins.
// Each pattern is tested against a single lower-case search string built from:
//   LOWER(category_path) + " | " + LOWER(category) + " | " + LOWER(department)
//
// Priority rules at the top handle cases where the store's retail logic
// places a product in an unexpected section:
//   • Fresh herbs live in the produce aisle → their category says "Grøntsager"
//     but they are culinary spices. The "urter" rule fires before grøntsag.
//   • "Nødder & Tørret Frugt" is a single category in several stores.
//     Without a priority rule, the generic "frugt" pattern wins — wrongly.

const RULES = [
  // ── Priority overrides ────────────────────────────────────────────────────
  { type: "krydderi", patterns: [/urter?(?:\s|$|&|,)/, /krydderurt/] },
  { type: "nødder",   patterns: [/nødder\s*(?:&|og)\s*tørret/, /nødder\s*(?:&|og)\s*frugt/] },

  // ── Protein ───────────────────────────────────────────────────────────────
  { type: "protein",  patterns: [
    /kød/, /fjerkræ/, /kylling/, /kalkun/, /svin/, /okse/, /lam/, /and\b/,
    /fisk/, /laks/, /tun\b/, /skaldyr/, /rejer/, /blæksprutte/,
    /pålæg/, /skinke/, /bacon/, /spegepølse/, /salami/, /charcuteri/,
    /bøf/, /hakket/, /schnitzel/, /koteletter?/, /mørbrad/,
    /tofu/, /tempeh/, /bælgfrugt(?:er)?/, /linser?/, /kikært/, /bønner?/,
  ]},

  // ── Mejeri ────────────────────────────────────────────────────────────────
  { type: "mejeri",   patterns: [
    /mejeri/, /mælk/, /fløde/, /cremefraiche/, /creme fraiche/,
    /yoghurt/, /skyr/, /kvarg/, /kefir/, /fromage/, /ricotta/, /mascarpone/,
    /ost\b/, /brie/, /camembert/, /gouda/, /emmentaler/, /mozzarella/, /fetaost/,
    /smør/, /margarine/,
    /æg(?:geprodukter)?$/,
  ]},

  // ── Grøntsager ────────────────────────────────────────────────────────────
  { type: "grøntsag", patterns: [
    /grøntsag/, /grønt\b/, /grøntsager/,
    /kartofler?/, /søde kartofler?/, /batater?/,
    /løg(?:er)?/, /porrer?/, /hvidløg/,
    /gulerødder?/, /selleri/, /persillerod/, /pastinakker?/,
    /kål/, /broccoli/, /blomkål/, /romanesco/, /rosenkål/, /spidskål/,
    /agurker?(?:\s|$)/, /squash/, /courgette/, /aubergine/, /peberfrugt/,
    /tomater?(?:\s|$)/, /cherrytomater?/,
    /champignon/, /svampe/, /kantareller?/,
    /spinat/, /rucola/, /salat(?:hoveder?)?/,
    /asparges/, /artiskok/, /fennikel/,
    /majs(?:\s|$)/, /ærter?(?:\s|$)/, /edamamebønner?/,
    /avocado/, /oliven(?:er)?/,
  ]},

  // ── Frugt ─────────────────────────────────────────────────────────────────
  { type: "frugt",    patterns: [
    /frugt\b/, /frugter/,
    /æbler?(?:\s|$)/, /pærer?(?:\s|$)/, /ferskner?/, /nektariner?/, /abrikoser?/,
    /blommer?(?:\s|$)/, /kirsebær/, /vindruer?/, /melon(?:er)?/,
    /bær\b/, /jordbær/, /hindbær/, /blåbær/, /brombær/, /ribs/, /solbær/,
    /citrusfrugter?/, /appelsiner?/, /mandariner?/, /citroner?/, /limer?(?:\s|$)/,
    /bananer?/, /ananas/, /mango(?:er)?/, /papaya/, /passionsfrugt/,
    /tørret frugt/, /dadler?/, /figner?/,
    /rosiner?/, /tranebær/,
  ]},

  // ── Korn / bagning ────────────────────────────────────────────────────────
  { type: "korn",     patterns: [
    /pasta(?:\s|$)/, /spaghetti/, /penne/, /fusilli/, /lasagne(?:plader)?/,
    /ris(?:\s|$)/, /risotto/, /basmati/, /jasminris/,
    /gryn/, /havre/, /havregryn/, /cornflakes/, /mysli/, /müsli/, /granola/,
    /mel(?:\s|$)/, /hvedemel/, /rugmel/, /speltmel/, /bagepulver/, /gær\b/,
    /brød(?:\s|$)/, /rugbrød/, /franskbrød/, /boller/, /bagels?/,
    /bagværk/, /kiks\b/, /knækbrød/, /tortilla/,
    /couscous/, /quinoa/, /bulgur/, /polenta/, /semulje/,
  ]},

  // ── Krydderier / tørrede urter ────────────────────────────────────────────
  { type: "krydderi", patterns: [
    /krydderi(?:er)?/, /krydderier og smaggivere/, /smaggivere/,
    /salt\b/, /peber\b/, /chili(?:\s|$)/, /paprika(?:\s|$)(?!.*peberfrugt)/,
    /spidskommen/, /karry/, /gurkemeje/, /ingefær(?:\s|$)/, /kanel(?:\s|$)/,
    /nellike/, /kardemomme/, /muskatnød/, /laurbær/,
    /rosmarin(?:\s|$)/, /timian(?:\s|$)/, /oregano/, /basilikum(?:\s|$)/,
    /persille(?:\s|$)/, /dild(?:\s|$)/, /koriander(?:\s|$)/, /mynthe/,
    /vanilj/, /safran/, /allehånde/, /anis\b/,
    /sennepsfrø/, /sesam/, /kommen/,
  ]},

  // ── Fedt / olie ───────────────────────────────────────────────────────────
  { type: "fedt",     patterns: [
    /olie(?:r)?(?:\s|$)/, /olivenolie/, /rapsolie/, /solsikkeolie/, /kokosolie/,
    /eddike(?:\s|$)/, /olie og eddike/,
    /svinefedt/, /andefedt/,
  ]},

  // ── Nødder / frø ──────────────────────────────────────────────────────────
  { type: "nødder",   patterns: [
    /nødder?(?:\s|$)/, /mandler?/, /hasselnødder?/, /valnødder?/,
    /cashewnødder?/, /pistacie/, /peanuts?/, /jordnødder?/,
    /frø(?:\s|$)/, /solsikkefrø/, /græskarkerner?/, /hørfrø/, /chiafrø/,
    /sesamfrø/,
    /peanutbutter/, /mandelsmør/, /tahini/, /nøddepasta/,
  ]},

  // ── Sauce / kondiment ─────────────────────────────────────────────────────
  { type: "sauce",    patterns: [
    /saucer?(?:\s|$)/, /dressing(?:er)?/, /marinade(?:r)?/,
    /ketchup/, /mayonnaise/, /mayo\b/, /remoulade/, /bearnaise/,
    /soja(?:sauce)?/, /worcester/, /tabasco/, /sambal/, /sriracha/,
    /tomatsauce/, /pesto(?:\s|$)/,
    /konserves/, /dåse(?:mad|tomater|bønner)?/,
    /suppe(?:terning|fond|pulver)/, /bouillon/, /fond\b/,
    /syltetøj/, /marmelade/, /honning(?:\s|$)/,
    /sirup(?:\s|$)/, /ahornsirup/, /agavesirup/,
    /hoisin/, /fisksauce/, /østerssauce/,
  ]},

  // ── Andet ─────────────────────────────────────────────────────────────────
  { type: "andet",    patterns: [
    /drikkevarer?/, /mineralvand/, /sodavand/, /juice(?:\s|$)/,
    /kaffe(?:\s|$)/, /te\b/, /kakao(?:\s|$)/,
    /øl\b/, /vin\b/, /spiritus/, /alkohol/,
    /slik\b/, /chokolade(?!\s*sauce)/, /konfekture/, /bolsjer?/,
    /snacks?/, /chips(?:\s|$)/, /popcorn/,
    /rengøring/, /vaskemiddel/, /opvask/, /toiletpapir/, /husholdning/,
    /personlig pleje/, /hygiejne/, /shampoo/,
    /baby(?:mad|varer|produkter)?/, /kæledyr/,
    /tobak/,
  ]},
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * inferProductType(categoryPath, category, department)
 *
 * Returns the culinary ingredient type for a product based on its store
 * category metadata, or null if no rule matches.
 *
 * @param {string|null} categoryPath  - Full hierarchy string (Bilka: "A / B / C / D")
 * @param {string|null} category      - Leaf category label
 * @param {string|null} department    - Top-level department label
 * @returns {string|null}
 */
export function inferProductType(categoryPath, category, department) {
  const haystack = [categoryPath, category, department]
    .filter(Boolean).join(" | ").toLowerCase();
  if (!haystack.trim()) return null;
  for (const rule of RULES) {
    if (rule.patterns.some(p => p.test(haystack))) return rule.type;
  }
  return null;
}

export const INGREDIENT_TYPES = [
  "krydderi", "grøntsag", "frugt", "protein",
  "mejeri",   "korn",     "fedt",  "nødder",
  "sauce",    "andet",
];
