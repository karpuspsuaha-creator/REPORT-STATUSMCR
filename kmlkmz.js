let AREA_POLYGONS = [];
let MASTER_UNIT_MAP = {}; // 🔥 lookup
let ACTIVITY_MAP = {}; // 🔥 lookup for ITEM CATEGORY and MATERIAL

// =========================
// NORMALIZER (IMPORTANT FIX)
// =========================
function cleanText(str) {
  return String(str || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^\w]/g, ""); // hapus titik, dash, dll
}

// =========================
// READ KML / KMZ
// =========================
async function readKML(file) {
  const fileName = file.name.toLowerCase();
  let kmlText = "";

  if (fileName.endsWith(".kml")) {
    kmlText = await file.text();
  } else if (fileName.endsWith(".kmz")) {
    const zip = await JSZip.loadAsync(file);

    for (const path in zip.files) {
      if (path.toLowerCase().endsWith(".kml")) {
        kmlText = await zip.files[path].async("text");
        break;
      }
    }
  }

  return new DOMParser().parseFromString(kmlText, "text/xml");
}

// =========================
// PARSE POINTS
// =========================
function parsePoints(xml) {
  const placemarks = [...xml.querySelectorAll("Placemark")];

  return placemarks.map((p) => {
    const name = (p.querySelector("name")?.textContent || "").trim();
    const coords = (p.querySelector("coordinates")?.textContent || "")
      .trim()
      .split(" ")[0]
      .split(",");

    return {
      name,
      lon: parseFloat(coords[0]),
      lat: parseFloat(coords[1]),
    };
  });
}

// =========================
// POLYGON
// =========================
function parsePolygons(xml) {
  const placemarks = [...xml.querySelectorAll("Placemark")];

  return placemarks.map((p) => {
    const name = (p.querySelector("name")?.textContent || "").trim();
    const coordsText = (
      p.querySelector("coordinates")?.textContent || ""
    ).trim();

    const coords = coordsText
      .split(" ")
      .filter(Boolean)
      .map((c) => {
        const [lon, lat] = c.split(",");
        return [parseFloat(lon), parseFloat(lat)];
      });

    return { name, coords };
  });
}

// AREA FINDER
function polygonCenter(coords) {
  let lat = 0;
  let lon = 0;

  coords.forEach(([x, y]) => {
    lon += x;
    lat += y;
  });

  return {
    lat: lat / coords.length,
    lon: lon / coords.length,
  };
}

function distance(lat1, lon1, lat2, lon2) {
  const R = 6371;

  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

// =========================
// POINT IN POLYGON
// =========================
function pointInPolygon(lat, lon, polygon) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][1],
      yi = polygon[i][0];
    const xj = polygon[j][1],
      yj = polygon[j][0];

    const intersect =
      yi > lon !== yj > lon &&
      lat < ((xj - xi) * (lon - yi)) / (yj - yi + 0.0000001) + xi;

    if (intersect) inside = !inside;
  }

  return inside;
}

// =========================
// LOCATION
// =========================
function findLocation(lat, lon) {
  let bestNearest = "";
  let bestDistance = Infinity;

  for (const area of AREA_POLYGONS) {
    // 1. kalau inside langsung return
    if (pointInPolygon(lat, lon, area.coords)) {
      return area.name;
    }

    // 2. hitung centroid untuk fallback
    const center = polygonCenter(area.coords);
    const d = distance(lat, lon, center.lat, center.lon);

    if (d < bestDistance) {
      bestDistance = d;
      bestNearest = area.name;
    }
  }

  // 3. kalau tidak masuk area → pakai nearest
  return bestNearest || "OUTSIDE AREA";
}

// =========================
// BUILD ACTIVITY MAP
// =========================
function buildActivityMap(activityData) {
  ACTIVITY_MAP = {};

  if (!activityData || !activityData.length) return;

  activityData.forEach((row) => {
    const eqp = cleanText(row["eqp"] || "");
    const kmlCategory = String(row["kml category"] || "")
      .trim()
      .toUpperCase();
    const job = String(row["job"] || "")
      .trim()
      .toUpperCase();

    if (!eqp) return;

    // Key lengkap: EQP + KML CATEGORY + JOB (paling spesifik)
    if (kmlCategory && job) {
      const keyFull = eqp + "|" + kmlCategory + "|" + job;
      ACTIVITY_MAP[keyFull] = {
        itemCategory: row["item category"] || "",
        material: row["material"] || "",
      };
    }

    // Key: EQP + KML CATEGORY (untuk kasus JOB kosong)
    if (kmlCategory) {
      const keyEqpCategory = eqp + "|" + kmlCategory;
      if (!ACTIVITY_MAP[keyEqpCategory]) {
        ACTIVITY_MAP[keyEqpCategory] = {
          itemCategory: row["item category"] || "",
          material: row["material"] || "",
        };
      }
    }

    // Key: EQP + JOB (fallback tanpa KML CATEGORY)
    if (job) {
      const keyEqpJob = eqp + "|" + job;
      if (!ACTIVITY_MAP[keyEqpJob]) {
        ACTIVITY_MAP[keyEqpJob] = {
          itemCategory: row["item category"] || "",
          material: row["material"] || "",
        };
      }
    }
  });
}

// =========================
// LOOKUP ACTIVITY
// =========================
function lookupActivity(eqpRaw, kmlCategoryRaw, jobRaw) {
  const eqpClean = cleanText(eqpRaw);
  const kmlCategoryClean = String(kmlCategoryRaw || "")
    .trim()
    .toUpperCase();
  const jobClean = String(jobRaw || "")
    .trim()
    .toUpperCase();

  // Prioritas 1: lookup dengan key lengkap (EQP + KML CATEGORY + JOB)
  if (kmlCategoryClean && jobClean) {
    const keyFull = eqpClean + "|" + kmlCategoryClean + "|" + jobClean;
    if (ACTIVITY_MAP[keyFull]) {
      return ACTIVITY_MAP[keyFull];
    }
  }

  // Prioritas 2: lookup dengan EQP + KML CATEGORY (jika JOB kosong atau tidak match)
  if (kmlCategoryClean) {
    const keyEqpCategory = eqpClean + "|" + kmlCategoryClean;
    if (ACTIVITY_MAP[keyEqpCategory]) {
      return ACTIVITY_MAP[keyEqpCategory];
    }
  }

  // Prioritas 3: lookup dengan EQP + JOB (fallback tanpa KML CATEGORY)
  if (jobClean) {
    const keyEqpJob = eqpClean + "|" + jobClean;
    if (ACTIVITY_MAP[keyEqpJob]) {
      return ACTIVITY_MAP[keyEqpJob];
    }
  }

  return { itemCategory: "", material: "" };
}

// =========================
// BUILD MASTER MAP
// =========================
function buildMasterUnitMap(masterData) {
  MASTER_UNIT_MAP = {};

  masterData.forEach((row) => {
    const code = String(row["Code Unit MCR"] || "")
      .trim()
      .toUpperCase();

    if (!code) return;

    const x = code.split("-");

    if (x.length < 5) return;

    const site = cleanText(x[0]);
    const eqp = cleanText(x[1]);

    const no = x[x.length - 1].replace(/\D/g, "").slice(-3).padStart(3, "0");

    const key = site + eqp + no;

    MASTER_UNIT_MAP[key] = {
      code,
      site,
      eqp,
      no,
    };
  });
}

// =========================
// SMART RESOLVER (ANCHOR + MASTER VALIDATION)
// =========================
function resolveSmart(siteRaw, eqpRaw, no) {
  const siteKML = cleanText(siteRaw);
  const eqpKML = cleanText(eqpRaw);

  // ======================
  // STEP 1:
  // cari SITE paling mirip
  // ======================

  let bestSite = "";
  let bestSiteScore = -1;

  const uniqueSites = [
    ...new Set(Object.values(MASTER_UNIT_MAP).map((x) => x.site)),
  ];

  for (const site of uniqueSites) {
    const score = eqpSimilarity(siteKML, site);

    if (score > bestSiteScore) {
      bestSiteScore = score;
      bestSite = site;
    }
  }

  // ======================
  // STEP 2:
  // KUNCI SITE + NO
  // ======================

  const candidates = Object.values(MASTER_UNIT_MAP).filter(
    (x) => x.site === bestSite && x.no === no,
  );

  if (!candidates.length) return "";

  // ======================
  // STEP 3:
  // EQP similarity
  // ======================

  let best = null;
  let bestScore = -1;

  for (const c of candidates) {
    const score = eqpSimilarity(eqpKML, c.eqp);

    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }

  return best?.code || "";
}

function eqpSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  let match = 0;

  for (let c of a) {
    if (b.includes(c)) match++;
  }

  return match / Math.max(a.length, b.length);
}

// =========================
// BUILD ROWS
// =========================
function buildRows(points, source = "") {
  return points.map((p) => {
    const parts = p.name.split(",").map((x) => x.trim());

    const site = parts[0] || "";
    const eqp = parts[1] || "";
    const no = (parts[2] || "").replace(/\D/g, "").slice(-3).padStart(3, "0");

    // 🔥 FIX: sudah jadi kolom sendiri
    const kmlCategory = (parts[3] || "").trim().toUpperCase();

    const job = parts[4] || "";

    const len = cleanText(site) + cleanText(eqp) + no;

    const resolved = resolveSmart(site, eqp, no);

    const resolvedData = Object.values(MASTER_UNIT_MAP).find(
      (x) => x.code === resolved,
    );

    const lenResolve = resolvedData
      ? cleanText(resolvedData.site) +
        cleanText(resolvedData.eqp) +
        String(resolvedData.no).padStart(3, "0")
      : "";

    const isEqpCorrect =
      resolvedData && cleanText(eqp) === cleanText(resolvedData.eqp);

    const isSiteCorrect =
      resolvedData && cleanText(site) === cleanText(resolvedData.site);

    // 🔥 Lookup ITEM CATEGORY and MATERIAL from ACTIVITY sheet (dengan KML CATEGORY)
    const activityData = lookupActivity(eqp, kmlCategory, job);

    return {
      Name: p.name,
      Name_Short: site,
      EQP: eqp,
      NO: no,
      "KML Category": kmlCategory, // ✅ FIX BENAR
      JOB: job, // ✅ FIX BENAR
      "ITEM CATEGORY": activityData.itemCategory,
      MATERIAL: activityData.material,
      Location_W: findLocation(p.lat, p.lon),
      LEN: len,
      LEN_RESOLVE: lenResolve,
      "Code Unit MCR": resolved,
      SFROM: source,
      _eqpValid: isEqpCorrect ? "OK" : "WRONG",
      _siteValid: isSiteCorrect ? "OK" : "WRONG",
    };
  });
}

// =========================
// EXPORT
// =========================
function exportExcel(data) {
  const cleanData = data.map(({ _eqpValid, _siteValid, ...rest }) => rest);

  // Buat worksheet dengan semua sel bertipe value (bukan formula)
  const ws = XLSX.utils.json_to_sheet(cleanData);

  // Konversi semua cell menjadi value type untuk mencegah interpretasi formula
  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  for (let R = range.s.r; R <= range.e.r; ++R) {
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cellRef = XLSX.utils.encode_cell({ r: R, c: C });
      if (ws[cellRef]) {
        const cell = ws[cellRef];
        // Pastikan semua cell adalah value, bukan formula
        if (cell.t === "f" || cell.t === "s") {
          // Jika formula, konversi ke value
          const value = cell.v !== undefined ? cell.v : cell.w || "";
          ws[cellRef] = { t: "s", v: String(value) };
        } else if (cell.t === "n") {
          // Number tetap sebagai number value
          ws[cellRef] = { t: "n", v: cell.v };
        } else {
          // Cell lainnya pastikan punya value
          if (cell.v === undefined) {
            ws[cellRef] = { t: "s", v: "" };
          }
        }
      }
    }
  }

  // pakai CLEAN DATA, bukan data asli
  const headers = Object.keys(cleanData[0] || {});

  ws["!cols"] = headers.map((header) => {
    let maxLength = header.length;

    cleanData.forEach((row) => {
      const value = String(row[header] || "");

      if (value.length > maxLength) {
        maxLength = value.length;
      }
    });

    return {
      wch: maxLength + 3,
    };
  });

  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(wb, ws, "RESULT");

  XLSX.writeFile(wb, "KML_RESULT.xlsx");
}

// =========================
// PREVIEW RESULT
// =========================
let currentPage = 1;
const rowsPerPage = 100;

function renderResultTable(data) {
  const container = document.getElementById("resultKML");
  const pagination = document.getElementById("kmlPagination");
  const info = document.getElementById("resultInfo");

  if (!data.length) {
    container.innerHTML = `<div class="empty-state">Tidak ada data</div>`;
    pagination.innerHTML = "";
    if (info) info.innerHTML = "";
    return;
  }

  const totalPages = Math.ceil(data.length / rowsPerPage);

  const start = (currentPage - 1) * rowsPerPage;
  const end = start + rowsPerPage;

  const pageData = data.slice(start, end);
  const headers = Object.keys(pageData[0]).filter(
    (key) => !key.startsWith("_"),
  );

  if (info) {
    const emptyMCR = data.filter(
      (x) => !String(x["Code Unit MCR"] || "").trim(),
    ).length;

    info.innerHTML = `
    Menampilkan ${start + 1} - ${Math.min(end, data.length)} dari ${data.length} data •
    Code Unit MCR kosong: <b style="color:#dc2626">${emptyMCR}</b>`;
  }

  let html = `
    <table>
      <thead><tr>
  `;

  headers.forEach((h) => (html += `<th>${h}</th>`));

  html += `</tr></thead><tbody>`;

  pageData.forEach((row) => {
    html += `<tr>`;
    headers.forEach((h) => {
      let value = row[h] ?? "";

      if (h === "EQP" && row._eqpValid === "WRONG") {
        html += `<td class="eqp-wrong">${value}</td>`;
      }
      // Name Short salah (SITE)
      else if (h === "Name_Short" && row._siteValid === "WRONG") {
        html += `<td class="site-wrong">${value}</td>`;
      } else {
        html += `<td>${value}</td>`;
      }
    });
    html += `</tr>`;
  });

  html += `</tbody></table>`;

  container.innerHTML = html;

  renderPagination(totalPages);
}

function changePage(page) {
  currentPage = page;
  renderResultTable(window.kmlResult);
}

function renderPagination(totalPages) {
  const pagination = document.getElementById("kmlPagination");

  if (totalPages <= 1) {
    pagination.innerHTML = "";
    return;
  }

  let html = "";

  html += `
    <button ${currentPage === 1 ? "disabled" : ""} onclick="changePage(${currentPage - 1})">
      ‹
    </button>
  `;

  for (let i = 1; i <= totalPages; i++) {
    html += `
      <button class="${i === currentPage ? "active" : ""}" onclick="changePage(${i})">
        ${i}
      </button>
    `;
  }

  html += `
    <button ${currentPage === totalPages ? "disabled" : ""} onclick="changePage(${currentPage + 1})">
      ›
    </button>
  `;

  pagination.innerHTML = html;
}

// =========================
// MAIN PROCESS
// =========================
async function processKMLKMZ(
  equipmentFile,
  areaFile,
  masterData,
  activityData,
  source = "",
) {
  const eqXML = await readKML(equipmentFile);
  const points = parsePoints(eqXML);

  const areaXML = await readKML(areaFile);
  AREA_POLYGONS = parsePolygons(areaXML);

  buildMasterUnitMap(masterData);
  buildActivityMap(activityData);

  const result = buildRows(points, source);

  return result;
}

// =========================
// HANDLER
// =========================
async function handleKMLProcess() {
  const startFile = document.getElementById("equipmentCoordinateStartFile")
    ?.files[0];
  const endFile = document.getElementById("equipmentCoordinateEndFile")
    ?.files[0];
  const areaFile = document.getElementById("boundaryKMLFile")?.files[0];
  const master = window.uploadedData?.masterUnit || [];
  const activity = window.uploadedData?.activity || [];

  if (!areaFile) {
    alert("Boundary harus diupload");
    return;
  }

  if (!startFile && !endFile) {
    alert("Equipment Coordinate Start atau End harus diupload");
    return;
  }

  try {
    const startRows = startFile
      ? await processKMLKMZ(startFile, areaFile, master, activity, "start")
      : [];
    const endRows = endFile
      ? await processKMLKMZ(endFile, areaFile, master, activity, "end")
      : [];

    const result = [...startRows, ...endRows];

    // simpan global
    window.kmlResult = result;

    // 🔥 RESET PAGE SETIAP RENDER BARU
    currentPage = 1;

    // render langsung
    renderResultTable(result);

    document.getElementById("exportKMLBtn").style.display = "block";

    alert("PROCESS SUCCESS ✔");
  } catch (err) {
    console.error(err);
    alert("FAILED PROCESS");
  }
}

window.handleKMLProcess = handleKMLProcess;

document.getElementById("exportKMLBtn")?.addEventListener("click", () => {
  if (window.kmlResult) {
    exportExcel(window.kmlResult);
  }
});
