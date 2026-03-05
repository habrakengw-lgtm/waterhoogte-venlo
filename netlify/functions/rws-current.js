// netlify/functions/rws-current.js
//
// Fetches the current measured water level at Venlo.
// Source: waterinfo.rws.nl/api/chart/get?mapType=waterhoogte&locationCodes=venlo&values=-48%2C48
//
// CSV structure per row: Datum;Tijd;Locatie;Gemeten waterstand;Verwachte waterstand;...
// The last MEASURED row is identified as the last row where BOTH col D and col E are filled.
// Example:
//   03-03-2026;09:10;Venlo;1229;1229   ← last measurement (both filled)
//   03-03-2026;09:20;Venlo;;1228       ← forecast only (col D empty)
// We use col D (index 3) as the water level value.

const RWS_URL = "https://waterinfo.rws.nl/api/chart/get?mapType=waterhoogte&locationCodes=venlo&values=-48%2C48";

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; WaterhoogteVenlo/1.0)",
  "Accept": "text/csv,text/plain,*/*",
  "Referer": "https://waterinfo.rws.nl/",
};

export async function handler() {
  try {
    const res = await fetch(RWS_URL, { headers: FETCH_HEADERS });
    if (!res.ok) throw new Error(`RWS HTTP ${res.status}`);
    const text = await res.text();
    const result = parseCurrentLevel(text);
    return {
      statusCode: 200,
      body: JSON.stringify(result),
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
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

function parseCurrentLevel(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) throw new Error("CSV te kort");

  const sep = lines[0].includes(";") ? ";" : ",";
  const hdr = lines[0].split(sep).map(h =>
    h.trim().replace(/^\uFEFF/, "").replace(/^"|"$/g, "").toLowerCase()
  );

  const iDatum = hdr.findIndex(h => h.includes("datum"));
  const iTijd  = hdr.findIndex(h => h.includes("tijd"));
  const iColD  = 3;  // column D: measured water level (cm NAP)
  const iColE  = 4;  // column E: forecast water level (cm NAP)

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

  // The last measurement row = last row where BOTH col D and col E have a value.
  // After that transition point, only col E (forecast) is populated.
  let lastH = NaN, lastMs = null;

  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(sep).map(v => v.trim().replace(/^"|"$/g, ""));
    if (!c[iDatum]) continue;

    const H  = parseNum(c[iColD]);
    const HE = parseNum(c[iColE]);

    // Both columns must be filled — this marks a measured (non-forecast-only) row
    if (isNaN(H) || isNaN(HE)) continue;

    const ts = iTijd >= 0 && c[iTijd] ? c[iTijd] : "00:00";
    const ms = parseMs(c[iDatum], ts);
    if (isNaN(ms)) continue;

    lastH  = H;    // col D = actual measured water level
    lastMs = ms;
  }

  if (isNaN(lastH) || lastMs === null) {
    throw new Error("Geen geldige waterstand gevonden (geen rij met zowel gemeten als verwachte waarde)");
  }

  // Format as dd-mm-yyyy hh:mm
  const dt   = new Date(lastMs);
  const dd   = String(dt.getDate()).padStart(2, "0");
  const mm   = String(dt.getMonth() + 1).padStart(2, "0");
  const yyyy = dt.getFullYear();
  const hh   = String(dt.getHours()).padStart(2, "0");
  const min  = String(dt.getMinutes()).padStart(2, "0");

  return {
    H_cmNAP:  Math.round(lastH * 10) / 10,
    datetime: `${dd}-${mm}-${yyyy} ${hh}:${min}`,
  };
}
