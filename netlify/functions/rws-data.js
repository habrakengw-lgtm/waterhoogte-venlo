// netlify/functions/rws-data.js
//
// Replicates the Excel "DATA_GRAFIEK" sheet logic:
//   - Source column: "Afvoer verwacht" (col E in CSV)
//     Only rows where this column has a value are used (= rows that show data in DATA_GRAFIEK)
//     Rows where it's empty → skipped (= "#N/A" in DATA_GRAFIEK cols D and F)
//   - Datetime at Venlo (col F in DATA_GRAFIEK):
//       F = Datum + Tijd + 2580 minutes  (Lag_minutes from Parameters sheet)
//   - Water level H (col D in DATA_GRAFIEK):
//       Polynomial per regime (LOW / MID / HIGH / EXTREME)

// ── Model parameters (Excel "Parameters" sheet) ──────────────────────────
const P = {
  Q_P70: 335.652, Q_P90: 661.022, Q_EXT: 1350.0,
  s_EXT: 0.365329, H_at_QEXT: 1468.871528,
  LOW:  { a0: 1124.125163, a1: 10.166296,  a2:  2.526432,  q_mean: 129.850031, q_std:  85.739993 },
  MID:  { a0: 1210.118821, a1: 30.70892,   a2:  2.240687,  q_mean: 473.631258, q_std:  88.385528 },
  HIGH: { a0: 1391.697171, a1: 91.653817,  a2: -26.999303, q_mean: 952.246329, q_std: 257.094962 },
};
// Excel formula: =DATA_RWS!A + DATA_RWS!B + TIME(0, 2580, 0)
// Excel's TIME() wraps at 24h (1440 min): TIME(0,2580,0) = TIME(0,1140,0) = 19 hours
// So the effective lag is 2580 mod 1440 = 1140 minutes, not 2580.
const LAG_MINUTES = 2580 % 1440; // = 1140 minutes = 19 hours

function getRegime(Q) {
  if (Q < P.Q_P70) return "LOW";
  if (Q < P.Q_P90) return "MID";
  if (Q < P.Q_EXT) return "HIGH";
  return "EXTREME";
}
function calcH(Q) {
  const r = getRegime(Q);
  if (r === "EXTREME") return P.H_at_QEXT + P.s_EXT * (Q - P.Q_EXT);
  const p = P[r], z = (Q - p.q_mean) / p.q_std;
  return p.a0 + p.a1 * z + p.a2 * z * z;
}

// ── CSV fetch ─────────────────────────────────────────────────────────────
const RWS_URL = "https://waterinfo.rws.nl/api/chart/getfan?location=sint%20pieter&kind=discharge";

async function fetchCSV() {
  const res = await fetch(RWS_URL, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; WaterhoogteVenlo/1.0)",
      "Accept": "text/csv,text/plain,*/*",
      "Referer": "https://waterinfo.rws.nl/",
    },
  });
  if (!res.ok) throw new Error(`RWS HTTP ${res.status}`);
  return res.text();
}

// ── CSV parse ─────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) throw new Error("CSV te kort");

  const sep = lines[0].includes(";") ? ";" : ",";
  const hdr = lines[0].split(sep).map(h =>
    h.trim().replace(/^\uFEFF/, "").replace(/^"|"$/g, "").toLowerCase()
  );

  const ci = name => hdr.findIndex(h => h.includes(name));
  const iDatum    = ci("datum");
  const iTijd     = ci("tijd");
  const iVerwacht = ci("afvoer verwacht");  // The only source column used by DATA_GRAFIEK

  if (iDatum < 0 || iVerwacht < 0) {
    throw new Error(`Kolommen niet gevonden. Beschikbaar: ${hdr.join(", ")}`);
  }

  const parseNum = v => {
    if (!v || v.trim() === "" || v.trim() === "-") return NaN;
    return parseFloat(v.trim().replace(",", "."));
  };

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(sep).map(v => v.trim().replace(/^"|"$/g, ""));
    if (!c[iDatum]) continue;

    // Skip rows where "Afvoer verwacht" is empty — these show #N/A in DATA_GRAFIEK
    const Q = parseNum(c[iVerwacht]);
    if (isNaN(Q)) continue;

    // Parse base datetime from Datum + Tijd columns
    const ds = c[iDatum];
    const ts = iTijd >= 0 && c[iTijd] ? c[iTijd] : "00:00";

    let baseMs;
    if (/^\d{4}-\d{2}-\d{2}/.test(ds)) {
      baseMs = new Date(`${ds}T${ts}:00`).getTime();
    } else {
      const [d, m, y] = ds.split("-");
      baseMs = new Date(
        `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}T${ts}:00`
      ).getTime();
    }
    if (isNaN(baseMs)) continue;

    // Column F in DATA_GRAFIEK: Q datetime + LAG_MINUTES
    // = the moment the water level is expected to arrive at Venlo
    const venloMs = baseMs + LAG_MINUTES * 60 * 1000;

    rows.push({
      datetime: new Date(venloMs).toISOString(),  // col F: Datum/tijd waterhoogte Venlo
      Q:        Math.round(Q * 100) / 100,
      H_cmNAP:  Math.round(calcH(Q) * 100) / 100, // col D: Verwachte waterhoogte Venlo
      regime:   getRegime(Q),
    });
  }

  if (!rows.length) throw new Error("Geen rijen met 'Afvoer verwacht' gevonden in CSV");
  rows.sort((a, b) => a.datetime.localeCompare(b.datetime));
  return rows;
}

// ── Handler ───────────────────────────────────────────────────────────────
export async function handler() {
  try {
    const csv  = await fetchCSV();
    const rows = parseCSV(csv);
    return {
      statusCode: 200,
      body: JSON.stringify(rows),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      },
    };
  } catch (err) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: err.message }),
      headers: { "Content-Type": "application/json" },
    };
  }
}
