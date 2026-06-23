// =========================
// READ ACTIVITY SHEET
// =========================
function extractActivitySheet(workbook) {
  const result = [];

  workbook.SheetNames.forEach((sheetName) => {
    const name = sheetName.toUpperCase().trim();

    if (name === "ACTIVITY") {
      console.log("ACTIVITY SHEET USED:", sheetName);

      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        defval: "",
      });

      if (rows.length) {
        result.push({
          sheet: sheetName,
          data: rows,
        });
      }
    }
  });

  return result;
}

// =========================
// PROCESS ACTIVITY SHEET DATA
// =========================
function processActivitySheet(data, sheetName = "") {
  if (!data?.length) return [];

  // Headers yang dicari di sheet ACTIVITY
  const wantedHeaders = [
    "eqp",
    "kml category",
    "job",
    "item category",
    "material",
  ];

  let headerIndex = -1;
  let cols = {};

  // Cari baris header
  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    for (let j = 0; j < row.length; j++) {
      const cell = normalizeHeader(row[j]);

      wantedHeaders.forEach((key) => {
        if (cols[key] === undefined && cell.includes(normalizeHeader(key))) {
          cols[key] = j;
        }
      });
    }

    if (Object.keys(cols).length >= 3) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) return [];

  const result = [];

  // Parse data rows
  for (let i = headerIndex + 1; i < data.length; i++) {
    const row = data[i];

    const obj = {
      _sheet: "ACTIVITY",
    };

    let hasValue = false;

    wantedHeaders.forEach((key) => {
      const col = cols[key];
      obj[key] = col >= 0 ? row[col] : "";

      if (String(obj[key]).trim()) {
        hasValue = true;
      }
    });

    if (hasValue) {
      result.push(obj);
    }
  }

  return result;
}

// =========================
// READ SPECIFIC MASTER SHEETS
// =========================
function extractMasterUnitSheet(workbook) {
  const result = [];

  workbook.SheetNames.forEach((sheetName) => {
    const name = sheetName.toUpperCase().trim();

    if (name.includes("#MASTER") || name.includes("$MASTER UNIT")) {
      console.log("MASTER SHEET USED:", sheetName);

      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        defval: "",
      });

      if (rows.length) {
        result.push({
          sheet: sheetName,
          data: rows,
        });
      }
    }
  });

  return result;
}

// =========================
// NORMALIZE
// =========================
function normalizeHeader(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getClassUnitHeaderMatch(str) {
  const cell = normalizeHeader(str);

  if (cell.includes("class unit")) return "exact";
  if (cell.includes("unit class")) return "exact";
  if (cell === "class") return "generic";

  return null;
}

// =========================
// MASTER PARSER BY SHEET
// =========================
function processMasterUnit(data, sheetName = "") {
  if (!data?.length) return [];

  const sheet = String(sheetName).toUpperCase();

  // =========================
  // #MASTER
  // =========================
  if (sheet.includes("#MASTER")) {
    let headerIndex = -1;

    let cols = {};

    const wanted = [
      "lokasi",
      "working area",
      "working section",
      "category",
      "item category",
      "description",
      "abc",
    ];

    // cari header
    for (let i = 0; i < data.length; i++) {
      const row = data[i];

      for (let j = 0; j < row.length; j++) {
        const cell = normalizeHeader(row[j]);

        wanted.forEach((key) => {
          if (cols[key] === undefined && cell.includes(normalizeHeader(key))) {
            cols[key] = j;
          }
        });
      }

      if (Object.keys(cols).length >= 3) {
        headerIndex = i;
        break;
      }
    }

    if (headerIndex === -1) return [];

    const result = [];

    for (let i = headerIndex + 1; i < data.length; i++) {
      const row = data[i];

      const obj = {
        _sheet: "#MASTER",
      };

      let hasValue = false;

      wanted.forEach((key) => {
        const col = cols[key];

        obj[key] = col >= 0 ? row[col] : "";

        if (String(obj[key]).trim()) {
          hasValue = true;
        }
      });

      if (hasValue) {
        result.push(obj);
      }
    }

    return result;
  }

  // =========================
  // $MASTER UNIT
  // =========================

  let headerIndex = -1;

  let companyCol = -1;
  let equipmentCol = -1;
  let codeCol = -1;
  let classunitCol = -1;
  let populasiCol = -1;

  let companyName = "";
  let equipmentName = "";
  let codeName = "";
  let classunitName = "";
  let populasiName = "";

  let foundClassUnitExact = false;

  // =========================
  // FIND HEADER ROW (FIXED)
  // =========================
  for (let i = 0; i < data.length; i++) {
    const row = data[i];

    for (let j = 0; j < row.length; j++) {
      const cell = normalizeHeader(row[j]);

      if (companyCol === -1 && cell.includes("company")) {
        companyCol = j;
        companyName = row[j];
      }

      if (equipmentCol === -1 && cell.includes("equipment")) {
        equipmentCol = j;
        equipmentName = row[j];
      }

      if (codeCol === -1 && cell.includes("code unit mcr")) {
        codeCol = j;
        codeName = row[j];
      }

      const classMatch = getClassUnitHeaderMatch(cell);

      if (classMatch === "exact" && !foundClassUnitExact) {
        classunitCol = j;
        classunitName = row[j];
        foundClassUnitExact = true;
      } else if (
        classMatch === "generic" &&
        classunitCol === -1 &&
        !foundClassUnitExact
      ) {
        classunitCol = j;
        classunitName = row[j];
      }

      // 🔥 POPULASI
      if (populasiCol === -1 && cell.includes("populasi")) {
        populasiCol = j;
        populasiName = row[j];
      }
    }

    if (
      companyCol !== -1 ||
      equipmentCol !== -1 ||
      codeCol !== -1 ||
      classunitCol !== -1 ||
      populasiCol !== -1
    ) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) return [];

  // =========================
  // PARSE DATA
  // =========================
  const result = [];

  for (let i = headerIndex + 1; i < data.length; i++) {
    const row = data[i];

    const company = companyCol >= 0 ? row[companyCol] : "";
    const equipment = equipmentCol >= 0 ? row[equipmentCol] : "";
    const code = codeCol >= 0 ? row[codeCol] : "";
    const classunit = classunitCol >= 0 ? row[classunitCol] : "";
    const populasi = populasiCol >= 0 ? row[populasiCol] : "";

    if (!company && !equipment && !code && !classunit && !populasi) continue;

    const obj = {
      _sheet: "$MASTER UNIT",
    };

    if (companyCol >= 0) obj[companyName] = company;
    if (equipmentCol >= 0) obj[equipmentName] = equipment;
    if (codeCol >= 0) obj[codeName] = code;
    if (classunitCol >= 0) obj[classunitName] = classunit;

    // 🔥 POPULASI FINAL
    if (populasiCol >= 0 && populasiName) {
      obj[populasiName] = populasi;
    }

    result.push(obj);
  }

  return result;
}
