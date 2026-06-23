// =========================
// FOREMAN STATE
// =========================
window.foremanData = [];

// =========================
// NORMALIZE HEADER
// =========================
function normalizeHeader(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// =========================
// FIND SHEET (STATUS ONLY)
// =========================
function extractForemanSheet(workbook) {
  const result = [];

  workbook.SheetNames.forEach((sheetName) => {
    const name = sheetName.toUpperCase().trim();

    // hanya sheet STATUS
    if (!name.includes("STATUS")) return;

    console.log("FOREMAN SHEET USED:", sheetName);

    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: "", // penting biar kolom kosong tetap masuk
      blankrows: true, // 🔥 ini penting supaya baris tidak hilang
    });

    result.push({
      sheet: sheetName,
      data: rows,
    });
  });

  return result;
}

// =========================
// FIND HEADER ROW (STRICT)
// =========================
function findHeaderIndex(data) {
  const target = [
    "code unit",
    "category",
    "item category",
    "awal",
    "akhir",
    "working area",
    "working section",
    "remarks",
    "keterangan",
    "lokasi",
  ];

  for (let i = 0; i < data.length; i++) {
    const row = data[i].map(normalizeHeader).join(" | ");

    const matchCount = target.filter((t) =>
      row.includes(normalizeHeader(t)),
    ).length;

    // header valid kalau minimal 2–3 keyword ketemu
    if (matchCount >= 2) {
      return i;
    }
  }

  return -1;
}

// =========================
// BUILD COLUMN MAP
// =========================
function buildColumnMap(headerRow) {
  const map = {};

  headerRow.forEach((cell, i) => {
    const h = normalizeHeader(cell);

    if (h.includes("code unit")) map.code = i;
    else if (h.includes("category") && !h.includes("item")) map.category = i;
    else if (h.includes("item category")) map.item = i;
    else if (h === "awal") map.start = i;
    else if (h === "akhir") map.end = i;
    else if (h.includes("working area")) map.area = i;
    else if (h.includes("working section")) map.section = i;
    else if (h.includes("remarks") || h.includes("keterangan")) map.remarks = i;
    else if (h.includes("lokasi")) map.location = i;
  });

  return map;
}

// =========================
// PARSE FOREMAN (NO DATA LOSS)
// =========================
function processForeman(data) {
  if (!data?.length) return [];

  const headerIndex = findHeaderIndex(data);
  if (headerIndex === -1) return [];

  const headerRow = data[headerIndex];
  const col = buildColumnMap(headerRow);

  const result = [];

  // 🔥 START FROM HEADER + 1 (NO FILTER REMOVE ROW)
  for (let i = headerIndex + 1; i < data.length; i++) {
    const row = data[i] || [];

    const code = col.code != null ? row[col.code] : "";
    const start = col.start != null ? row[col.start] : "";
    const end = col.end != null ? row[col.end] : "";

    // ❗ jangan filter terlalu keras (INI YANG BIKIN DATA HILANG)
    if (!code && !start && !end) continue;

    result.push({
      "Code Unit MCR": String(code || "")
        .trim()
        .toUpperCase(),
      Category:
        col.category != null ? String(row[col.category] || "").trim() : "",
      "Item Category":
        col.item != null ? String(row[col.item] || "").trim() : "",
      Start: String(start || "").trim(),
      End: String(end || "").trim(),
      "Working Area":
        col.area != null ? String(row[col.area] || "").trim() : "",
      "Working Section":
        col.section != null ? String(row[col.section] || "").trim() : "",
      Remarks: col.remarks != null ? String(row[col.remarks] || "").trim() : "",
      Location:
        col.location != null ? String(row[col.location] || "").trim() : "",
    });
  }

  return result;
}

// =========================
// PIPELINE (SAFE)
// =========================
const foremanPipeline = {
  validate: (file) =>
    [".xlsx", ".xlsm", ".xlsb"].some((ext) =>
      file.name.toLowerCase().endsWith(ext),
    ),

  process: async (file) => {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });

    const sheets = extractForemanSheet(workbook);

    let result = [];

    sheets.forEach(({ data }) => {
      result.push(...processForeman(data));
    });

    window.foremanData = result;

    console.log("FOREMAN TOTAL:", result.length);

    return result;
  },
};

// =========================
// EXPORT
// =========================
window.foremanPipeline = foremanPipeline;
window.processForeman = processForeman;
