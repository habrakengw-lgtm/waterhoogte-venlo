// netlify/functions/rws-history.js
//
// Fetches measured water levels at Venlo for the past ~9 days and returns
// the last 5 days of rows where column D (measured) has a value.
// URL: waterinfo.rws.nl/api/chart/get?mapType=waterhoogte&locationCodes=venlo&values=-216%2C48
//
// CSV columns: Datum ; Tijd ; Locatie ; Gemeten waterstand (col D) ; Verwacht (col E) ; ...
// Returns only rows where col D is filled (actual measurements, not forecast).

const RWS_URL = "https://waterinfo.rws.nl/api/chart/get?mapType=waterhoogte&locationCodes=venlo&values=-216%2C48";

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; WaterhoogteVenlo/1.0)",
  "Accept":     "text/csv,text/plain,*/*",
  "Referer":    "https://waterinfo.rws.nl/",
};

const DAYS_BACK = 5;

export async function handler() {
  try {
    const res = await fetch(RWS_URL, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`RWS HTTP ${res.status}`);
    const text = await res.text();
    const rows = parseHistory(text);
    return {
      statusCode: 200,
      body: JSON.stringify(rows),
      headers: {
        "Content-Type":  "application/json; charset=utf-8",
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

function parseHistory(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) throw new Error("CSV te kort");

  const sep = lines[0].includes(";") ? ";" : ",";
  const hdr = lines[0].split(sep).map(h =>
    h.trim().replace(/^\uFEFF/, "").replace(/^"|"$/g, "").toLowerCase()
  );

  const iDatum = hdr.findIndex(h => h.includes("datum"));
  const iTijd  = hdr.findIndex(h => h.includes("tijd"));
  const iColD  = 3;  // column D: measured water level (cm NAP)

  const parseNum = v => {
    if (!v || v.trim() === "" || v.trim() === "-") return NaN;
    return parseFloat(v.trim().replace(",", "."));
  };

  const parseMs = (ds, ts) => {
    if (/^\d{4}-\d{2}-\d{2}/.test(ds)) {
      return new Date(`${ds}T${ts}:00`).getTime();
    }
    const [d, m, y] = ds.split("-");
    return new Date(`${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}T${ts}:00`).getTime();
  };

  // Cutoff: only keep rows from last DAYS_BACK days
  const cutoffMs = Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(sep).map(v => v.trim().replace(/^"|"$/g, ""));
    if (!c[iDatum]) continue;

    const H = parseNum(c[iColD]);
    if (isNaN(H)) continue;  // skip forecast-only rows (col D empty)

    const ts = iTijd >= 0 && c[iTijd] ? c[iTijd] : "00:00";
    const ms = parseMs(c[iDatum], ts);
    if (isNaN(ms) || ms < cutoffMs) continue;  // skip rows older than 5 days

    rows.push({
      datetime: new Date(ms).toISOString(),
      H_cmNAP:  Math.round(H * 10) / 10,
    });
  }

  if (!rows.length) throw new Error("Geen gemeten waterstand gevonden in de laatste 5 dagen");
  rows.sort((a, b) => a.datetime.localeCompare(b.datetime));
  return rows;
}
