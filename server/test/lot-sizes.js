// Guards the MCX contract multipliers in db.js SEED_COMMODITIES.
//
// `lot_size` must be the contract size EXPRESSED IN THE QUOTED UNIT, so that
// `qty x live price` is the true notional of one contract. Every convenient
// source of this number is WRONG:
//   * a broker's "Lot size" column prints the physical trading unit ("1 kg")
//   * Angel's scrip master drops the unit  (GOLD 1, GOLDM 100, ZINC 5)
//   * Kite returns 1 for every MCX instrument, by design
// So the multipliers are hard-coded, and this test re-derives each one from the
// contract specification and checks a known notional. If it fails, someone has
// re-scraped a broker page into the column.
//
//   node test/lot-sizes.js
const path = require('path');

// --- expected specs, from the MCX contract specification PDFs -----------------
// [ trading unit (in the base measure), quotation base (same measure), multiplier ]
const SPECS = {
  GOLD: { unit: 1000, per: 10, measure: 'g', mult: 100 },
  GOLDM: { unit: 100, per: 10, measure: 'g', mult: 10 },
  GOLDPETAL: { unit: 1, per: 1, measure: 'g', mult: 1 },
  SILVER: { unit: 30, per: 1, measure: 'kg', mult: 30 },
  SILVERM: { unit: 5, per: 1, measure: 'kg', mult: 5 },
  SILVERMIC: { unit: 1, per: 1, measure: 'kg', mult: 1 },
  CRUDEOIL: { unit: 100, per: 1, measure: 'bbl', mult: 100 },
  CRUDEOILM: { unit: 10, per: 1, measure: 'bbl', mult: 10 },
  NATURALGAS: { unit: 1250, per: 1, measure: 'mmBtu', mult: 1250 },
  NATGASMINI: { unit: 250, per: 1, measure: 'mmBtu', mult: 250 },
  COPPER: { unit: 2500, per: 1, measure: 'kg', mult: 2500 },
};

// Sanity notionals: an approximate live price in the QUOTED unit and the order of
// magnitude one contract must come to (Sep-2026 prices). Deliberately loose — this
// catches a 10x/100x unit error, not price drift.
const NOTIONAL = {
  GOLD: [152815, 1.5e7, 1.6e7],
  GOLDM: [152815, 1.4e6, 1.6e6],
  GOLDPETAL: [15356, 1.4e4, 1.6e4],
  SILVER: [237500, 6.9e6, 7.3e6],
  SILVERM: [237500, 1.1e6, 1.3e6],
  SILVERMIC: [237500, 2.3e5, 2.5e5],
  CRUDEOIL: [8200, 7.9e5, 8.6e5],
  CRUDEOILM: [8200, 7.9e4, 8.6e4],
  NATURALGAS: [281.2, 3.4e5, 3.6e5],
  NATGASMINI: [281.2, 6.8e4, 7.2e4],
  COPPER: [1378.1, 3.4e6, 3.5e6],
};

// Pull SEED_COMMODITIES out of db.js without booting a database.
function loadSeed() {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8');
  const m = src.match(/const SEED_COMMODITIES = (\[[\s\S]*?\n\]);/);
  if (!m) throw new Error('SEED_COMMODITIES not found in src/db.js');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]}`)();
}

let pass = 0; const fails = [];
const check = (name, cond, detail) => {
  if (cond) { pass += 1; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const seed = loadSeed();
const bySymbol = new Map(seed.map(([symbol, dispName, price, lot]) => [symbol, { dispName, price, lot }]));

console.log(`SEED_COMMODITIES: ${seed.length} contracts\n`);
console.log('symbol       lot_size  derived  1 lot @ ref price');
console.log('-'.repeat(58));

for (const [symbol, spec] of Object.entries(SPECS)) {
  const row = bySymbol.get(symbol);
  if (!row) { check(symbol, false, 'missing from SEED_COMMODITIES'); continue; }

  // 1. the multiplier must equal trading unit / quotation base
  const derived = spec.unit / spec.per;
  check(`${symbol} multiplier`, row.lot === derived,
    `lot_size ${row.lot} but ${spec.unit}${spec.measure} / ${spec.per}${spec.measure} = ${derived}`);
  check(`${symbol} expected`, row.lot === spec.mult, `expected ${spec.mult}, got ${row.lot}`);

  // 2. one contract must come to the right order of magnitude
  const [px, lo, hi] = NOTIONAL[symbol];
  const notional = row.lot * px;
  check(`${symbol} notional`, notional >= lo && notional <= hi,
    `1 lot = ₹${Math.round(notional).toLocaleString('en-IN')}, expected ₹${lo.toExponential(1)}–₹${hi.toExponential(1)}`);

  // 3. the placeholder price must be in the QUOTED unit, not the parent's
  check(`${symbol} base_price`, Math.abs(row.price - px) / px < 0.2,
    `base_price ${row.price} is not in the quoted unit (expected ~${px})`);

  console.log(
    symbol.padEnd(12),
    String(row.lot).padStart(8),
    String(derived).padStart(8),
    ` ₹${Math.round(notional).toLocaleString('en-IN')}`,
  );
}

// The traps that produced the wrong numbers before — assert they stay closed.
check('GOLD is not 1', bySymbol.get('GOLD').lot !== 1,
  "Angel's scrip master says GOLD lotsize=1 (that's 1 KG, not 1 unit of the ₹/10g quote)");
check('GOLDM is not 100', bySymbol.get('GOLDM').lot !== 100,
  "Angel's scrip master says GOLDM lotsize=100 (that's 100 GRAMS, quoted per 10 g -> 10)");
check('no MCX lot is 1 across the board', seed.filter(([, , , l]) => l === 1).length <= 2,
  'Kite returns lot_size=1 for every MCX instrument — that must not have been seeded');
check('NATGASMINI symbol', bySymbol.has('NATGASMINI'),
  'the exchange symbol is NATGASMINI, not NATURALGASMINI — a mismatch breaks lookup silently');
check('no COPPERM', !bySymbol.has('COPPERM'),
  'MCX lists no copper mini/micro futures');
// GOLDPETAL is quoted per gram while the rest of the gold family is per 10 g.
check('GOLDPETAL quoted per gram', bySymbol.get('GOLDPETAL').price < bySymbol.get('GOLD').price / 5,
  'GOLDPETAL placeholder looks like a ₹/10g price — it is quoted per GRAM');

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) {
  console.log('\nFAILURES:');
  for (const f of fails) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ all MCX contract multipliers match the exchange specification');
