// =========================
// KOMDIS STATE
// =========================
window.komdisData = [];

// =========================
// NORMALIZE
// =========================
function normalizeHeader(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// =========================
// FIND SHEET
// =========================
function extractKomdisSheet(workbook) {
  const result = [];

  workbook.SheetNames.forEach((sheetName) => {
    const name = sheetName.toUpperCase().trim();

    // sesuaikan kalau nama sheet beda
    if (!name.includes("KOMDIS") && !name.includes("STATUS")) return;

    console.log("KOMDIS SHEET USED:", sheetName);

    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: "",
      blankrows: true,
    });

    result.push({
      sheet: sheetName,
      data: rows,
    });
  });

  return result;
}

// =========================
// FIND HEADER
// =========================
function findKomdisHeader(data) {
  const target = ["code unit", "item category", "awal", "akhir", "lokasi"];

  for (let i = 0; i < data.length; i++) {
    const row = data[i].map(normalizeHeader).join("|");

    const score = target.filter((x) => row.includes(x)).length;

    if (score >= 2) {
      return i;
    }
  }

  return -1;
}

// =========================
// BUILD MAP
// =========================
function buildKomdisColumnMap(header) {
  const map = {};

  header.forEach((cell, i) => {
    const h = normalizeHeader(cell);

    if (h.includes("code unit")) map.code = i;
    else if (h.includes("item category")) map.item = i;
    else if (h === "awal") map.start = i;
    else if (h === "akhir") map.end = i;
    else if (h.includes("lokasi")) map.location = i;
  });

  return map;
}

// =========================
// PROCESS KOMDIS
// =========================
function processKomdis(data) {
  if (!data?.length) return [];

  const headerIndex = findKomdisHeader(data);

  if (headerIndex === -1) return [];

  const col = buildKomdisColumnMap(data[headerIndex]);

  const result = [];

  for (let i = headerIndex + 1; i < data.length; i++) {
    const row = data[i] || [];

    const code = col.code != null ? row[col.code] : "";

    const start = col.start != null ? row[col.start] : "";

    const end = col.end != null ? row[col.end] : "";

    if (!code && !start && !end) continue;

    result.push({
      "Code Unit MCR": String(code || "")
        .trim()
        .toUpperCase(),

      "Item Category":
        col.item != null ? String(row[col.item] || "").trim() : "",

      Start: String(start || "").trim(),

      End: String(end || "").trim(),

      Location:
        col.location != null ? String(row[col.location] || "").trim() : "",
    });
  }

  return result;
}

// =========================
// PIPELINE
// =========================
const komdisPipeline = {
  validate: (file) =>
    [".xlsx", ".xlsm", ".xlsb"].some((ext) =>
      file.name.toLowerCase().endsWith(ext),
    ),

  process: async (file) => {
    const workbook = XLSX.read(await file.arrayBuffer(), {
      type: "array",
    });

    const sheets = extractKomdisSheet(workbook);

    let result = [];

    sheets.forEach(({ data }) => {
      result.push(...processKomdis(data));
    });

    window.komdisData = result;

    console.log("KOMDIS TOTAL:", result.length);

    return result;
  },
};

// =========================
// EXPORT
// =========================
window.komdisPipeline = komdisPipeline;

window.processKomdis = processKomdis;
