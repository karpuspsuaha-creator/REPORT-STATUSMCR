const EXCLUDED_COMPANIES = [
  "PT. CCEPC",
  "PT. HTI",
  "PT. KAN",
  "PT. MCC",
  "PT. SHAN MEI",
  "PT. SIG",
  "PT. SKA",
  "PT. SINOMA",
  "PT. BBK",
];

const SHIFT_TEMPLATE = {
  "Shift 1": [
    { start: "06:00", end: "06:15", type: "Change Shift" },
    { start: "06:15", end: "12:00", type: "Activity" },
    { start: "12:00", end: "13:00", type: "Meal and Rest" },
    { start: "13:00", end: "17:45", type: "Activity" },
    { start: "17:45", end: "18:00", type: "Change Shift" },
  ],

  "Shift 2": [
    { start: "18:00", end: "18:15", type: "Change Shift" },
    { start: "18:15", end: "00:00", type: "Activity" },
    { start: "00:00", end: "01:00", type: "Meal and Rest" },
    { start: "01:00", end: "05:45", type: "Activity" },
    { start: "05:45", end: "06:00", type: "Change Shift" },
  ],
};

function toMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function toTime(min) {
  const h = String(Math.floor(min / 60) % 24).padStart(2, "0");
  const m = String(min % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function normalizeRange(start, end) {
  let s = toMinutes(start);
  let e = toMinutes(end);

  if (e <= s) {
    e += 24 * 60;
  }

  return {
    start: s,
    end: e,
  };
}

function isActivitySlot(type) {
  return String(type || "").trim() === "Activity";
}

function isSystemSlot(type) {
  return ["Activity", "Meal and Rest", "Change Shift", "Waiting Blasting"].includes(
    String(type || "").trim(),
  );
}

function normalizeTimeInput(value) {
  if (value === null || value === undefined) return "";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";

    return toTime(Math.round(value * 24 * 60));
  }

  const text = String(value).trim();
  if (!text) return "";

  if (text.includes(":")) return text;

  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return toTime(Math.round(numeric * 24 * 60));
  }

  return text;
}

function formatDuration(totalMinutes) {
  const safe = Math.max(0, Number(totalMinutes) || 0);
  return Number((safe / 60).toFixed(2));
}

function getTimeTotal(start, end) {
  if (!start || !end) return 0;

  const startMin = toMinutes(start);
  const endMin = toMinutes(end);
  const duration =
    endMin >= startMin ? endMin - startMin : 24 * 60 - startMin + endMin;

  return formatDuration(duration);
}

function getShiftBase(shift) {
  return (SHIFT_TEMPLATE[shift] || []).map((s) => ({
    start: s.start,
    end: s.end,
    type: s.type,
  }));
}

function getShiftStageSlots(shift) {
  if (shift === "Shift 2") {
    return {
      start: { start: "18:15", end: "00:00" },
      end: { start: "01:00", end: "05:45" },
    };
  }

  return {
    start: { start: "06:15", end: "12:00" },
    end: { start: "13:00", end: "17:45" },
  };
}

function buildKMLOverrideMap(selectedShift, startRows = [], endRows = []) {
  const grouped = {};
  const slots = getShiftStageSlots(selectedShift);

  const addRows = (rows, slot) => {
    (rows || []).forEach((row) => {
      const code = normalizeCode(row["Code Unit MCR"] || row["Code Unit"]);
      const job = String(row.JOB || "").trim();

      if (!code || !job) return;

      if (!grouped[code]) grouped[code] = [];

      grouped[code].push({
        start: slot.start,
        end: slot.end,
        type: "Activity", // FIX UTAMA
        job: job, // tetap simpan
      });
    });
  };

  addRows(startRows, slots.start);
  addRows(endRows, slots.end);

  return grouped;
}

function buildOverrides(source, komdisCodeSet = new Set()) {
  const grouped = {};

  normalizeSource(source).forEach((r) => {
    const start = normalizeTimeInput(r["Start"]);
    const end = normalizeTimeInput(r["End"]);

    if (!start) return;

    const code = normalizeCode(r["Code Unit MCR"] || r["Code Unit"]);

    if (!code) return;

    if (!grouped[code]) {
      grouped[code] = [];
    }

    // 🔥 DETECT KOMDIS BERDASARKAN CODE (BUKAN OBJECT)
    const isKomdis = komdisCodeSet.has(code);

    grouped[code].push({
      start,
      end,

      type:
        String(r["Item Category"] || "").trim() ||
        String(r["Category"] || "").trim() ||
        "Override",

      category: String(r["Category"] || "").trim(),
      remarks: String(r["Remarks"] || "").trim(),
      location: String(r["Location"] || "").trim(),
      codeUnit: code,

      // 🔥 FIX UTAMA
      source: isKomdis ? "KOMDIS" : "FOREMAN",
    });
  });

  return grouped;
}

function mergeTimeline(base, overrides) {
  const result = [];

  base.forEach((slot) => {
    // =========================
    // NON ACTIVITY
    // =========================
    if (!isActivitySlot(slot.type)) {
      result.push({
        start: slot.start,
        end: slot.end,
        type: slot.type,
      });

      return;
    }

    // =========================
    // ACTIVITY SLOT
    // =========================
    const baseRange = normalizeRange(slot.start, slot.end);

    let current = baseRange.start;

    const ovs = (overrides || [])
      // 🔥 FIX: jangan pakai o.end karena KOMDIS bisa kosong end
      .filter((o) => o.start)

      .map((o) => {
        let oStart = toMinutes(o.start);

        // 🔥 kalau end kosong
        // otomatis extend sampai akhir activity slot
        let oEnd = o.end ? toMinutes(o.end) : baseRange.end;

        // crossing midnight
        if (oEnd <= oStart) {
          oEnd += 24 * 60;
        }

        return {
          ...o,
          _start: oStart,
          _end: oEnd,
        };
      })

      // overlap dengan activity slot
      .filter((o) => o._end > baseRange.start && o._start < baseRange.end)

      // urutkan berdasarkan waktu mulai
      .sort((a, b) => a._start - b._start);

    // tidak ada override
    if (!ovs.length) {
      result.push({
        start: slot.start,
        end: slot.end,
        type: slot.type,
      });

      return;
    }

    ovs.forEach((o) => {
      const oStart = Math.max(o._start, baseRange.start);

      const oEnd = Math.min(o._end, baseRange.end);

      // =========================
      // SISA ACTIVITY SEBELUM OVERRIDE
      // =========================
      if (current < oStart) {
        result.push({
          start: toTime(current % (24 * 60)),
          end: toTime(oStart % (24 * 60)),
          type: "Activity",
        });
      }

      // =========================
      // INSERT OVERRIDE
      // =========================
      result.push({
        start: toTime(oStart % (24 * 60)),
        end: toTime(oEnd % (24 * 60)),

        type: o.type || "Override",

        category: o.category || "",

        remarks: o.remarks || "",

        location: o.location || "",

        codeUnit: o.codeUnit || "",

        source: o.source || "",
      });

      current = Math.max(current, oEnd);
    });

    // =========================
    // SISA ACTIVITY TERAKHIR
    // =========================
    if (current < baseRange.end) {
      result.push({
        start: toTime(current % (24 * 60)),
        end: toTime(baseRange.end % (24 * 60)),
        type: "Activity",
      });
    }
  });

  return result;
}

// =========================
// ACTIVITY MAP (MAX 12 HOURS)
// =========================
const MAX_ACTIVITY_HOURS = 12;

function isActivityType(type) {
  return String(type || "")
    .toLowerCase()
    .includes("activity");
}

function capTimelineActivitySlots(timeline) {
  // timeline diharapkan urut berdasarkan start.
  // Kita hitung total durasi slot yang bertipe Activity.
  const totalMinutesCap = MAX_ACTIVITY_HOURS * 60;
  let used = 0;

  return timeline.map((slot) => {
    if (!isActivityType(slot.type)) return slot;

    const startMin = toMinutes(slot.start);
    const endMin = toMinutes(slot.end);
    const rawDuration =
      endMin >= startMin ? endMin - startMin : 24 * 60 - startMin + endMin;

    const remaining = totalMinutesCap - used;
    if (remaining <= 0) {
      // kalau sudah mentok, ubah jadi Meal/Break (biar tetap “ada jamnya” di timeline)
      return { ...slot, type: "Meal and Rest" };
    }

    const keepDuration = Math.min(rawDuration, remaining);
    used += keepDuration;

    if (keepDuration === rawDuration) return slot;

    // potong end
    const newEnd = toTime(
      startMin + keepDuration >= 24 * 60
        ? (startMin + keepDuration) % (24 * 60)
        : startMin + keepDuration,
    );
    return { ...slot, end: newEnd };
  });
}

function buildActivityRowTimeline(
  baseShift,
  overridesMap,
  code,
  selectedShift,
  kmlMeta,
) {
  // Ambil timeline hasil merge dulu (bisa jadi >5 slot Activity)
  const overrides =
    kmlOverridesMap && kmlOverridesMap[code]?.length
      ? kmlOverridesMap[code]
      : overridesMap[code] || [];

  const merged = overrides.length
    ? mergeTimeline(baseShift, overrides).map((slot) => ({
        start: slot.start,
        end: slot.end,
        type: slot.type || "",
        category: kmlMeta.category || "",
      }))
    : baseShift.map((slot) => ({
        start: slot.start,
        end: slot.end,
        type: slot.type,
        category: kmlMeta.category || "",
      }));

  // Cap total Activity duration maksimal 12 jam
  const capped = capTimelineActivitySlots(merged);

  // Pastikan urutan slot tetap.
  return capped;
}

// Data dari KML
function mapKmlCategory(kml) {
  const v = String(kml || "").toUpperCase();

  if (v === "BD") return "BD Unschedule";
  if (v === "R") return "Working";
  if (v === "NR") return "No Operator";
  if (v === "Y") return "No Operator";
  if (v === "NJ") return "No Job";

  return "";
}

function getKmlCategoryPriority(category) {
  if (category === "Working") return 4;
  if (category === "No Operator") return 3;
  if (category === "Breakdown") return 2;
  if (category === "No Job") return 1;

  return 0;
}

function choosePreferredKmlCategory(currentCategory, nextCategory) {
  const currentPriority = getKmlCategoryPriority(currentCategory);
  const nextPriority = getKmlCategoryPriority(nextCategory);

  if (nextPriority > currentPriority) return nextCategory;
  if (nextPriority === currentPriority) return currentCategory || nextCategory;

  return currentCategory || nextCategory;
}

// =========================
// REPORT STATUS CONFIG
// =========================

const REPORT_STATUS_COLUMNS = [
  "Date",
  "Shift",
  "Code Unit",
  "Equipment",
  "Category",
  "Item Category",
  "Working Area",
  "Working Section",
  "Before",
  "After",
  "Time Total",
  "Remarks",
  "Location",
  "Material",
  "Category BD",
  "Cut Off Report",
  "Class Unit",
  "Populasi", //
  "ABC - CC",
];

let reportStatusData = [];
const REPORT_STATUS_ROWS_PER_PAGE = 50;
let reportStatusCurrentPage = 1;
let reportStatusSummary = {
  total: 0,
  filled: 0,
  empty: 0,
};

// =========================
// MODE TRACKING (LOAD vs GENERATE)
// =========================
let reportStatusMode = null; // 'load' | 'generate' | null
let reportStatusSourceInfo = null; // untuk tracking sumber data

// =========================
// EDIT STATE
// =========================
let editingRowIndex = -1;
let editingRowData = {};
let selectedRows = new Set();
let lastSelectedFilteredPosition = -1;
let waitingBlastingMode = false;
let waitingBlastingLocations = [];

// Helper: generate unique key for a row
function getRowKey(row, index) {
  return `${row["Code Unit"] || ""}|${row["Before"] || ""}|${row["After"] || ""}|${index}`;
}

// =========================
// FIND HEADER SMART
// =========================

function findKey(obj, keywords = []) {
  const keys = Object.keys(obj || {});

  return keys.find((k) => {
    const h = String(k).toLowerCase().replace(/\s+/g, " ").trim();

    return keywords.some((x) => h.includes(String(x).toLowerCase().trim()));
  });
}

// =========================
// ARRAY → OBJECT
// =========================

function normalizeSource(rawData) {
  if (Array.isArray(rawData) && rawData.length && Array.isArray(rawData[0])) {
    const headers = rawData[0];

    return rawData
      .slice(1)
      .filter((row) => row.some((x) => String(x).trim() !== ""))
      .map((row) => {
        let obj = {};

        headers.forEach((h, i) => {
          obj[h] = row[i] ?? "";
        });

        return obj;
      });
  }

  return rawData || [];
}

// =========================
// BUILD KML MAP
// =========================
function addKMLRowsToMap(
  targetMap,
  rows = [],
  { preserveExisting = false } = {},
) {
  (rows || []).forEach((row) => {
    const code = String(row["Code Unit MCR"] || "")
      .trim()
      .toUpperCase();

    if (!code) return;

    const nextCategory = mapKmlCategory(row["KML Category"]);
    const nextLocation = String(row.Location_W || "").trim();
    const nextItemCategory = String(row["ITEM CATEGORY"] || "").trim();
    const source = String(row.SFROM || "")
      .trim()
      .toLowerCase();
    const nextStartLocation = source === "start" ? nextLocation : "";
    const nextEndLocation = source === "end" ? nextLocation : "";

    if (!targetMap[code]) {
      targetMap[code] = {
        location: nextLocation,
        startLocation: nextStartLocation,
        endLocation: nextEndLocation,
        category: nextCategory,
        itemCategory: nextItemCategory,
        // 🔥 Simpan ITEM CATEGORY terpisah untuk start dan end
        startItemCategory: source === "start" ? nextItemCategory : "",
        endItemCategory: source === "end" ? nextItemCategory : "",
      };
      return;
    }

    const current = targetMap[code];

    targetMap[code] = {
      location: current.location || nextLocation,
      startLocation: current.startLocation || nextStartLocation,
      endLocation: current.endLocation || nextEndLocation,
      category: preserveExisting
        ? current.category
        : choosePreferredKmlCategory(current.category, nextCategory),
      // 🔥 Pertahankan ITEM CATEGORY pertama yang tidak kosong untuk konsistensi
      itemCategory: current.itemCategory || nextItemCategory,
      // 🔥 Simpan ITEM CATEGORY terpisah untuk start dan end
      startItemCategory:
        current.startItemCategory ||
        (source === "start" ? nextItemCategory : ""),
      endItemCategory:
        current.endItemCategory || (source === "end" ? nextItemCategory : ""),
    };
  });
}

function buildKMLMap() {
  const map = {};

  addKMLRowsToMap(map, window.kmlResultStart || [], {
    preserveExisting: false,
  });
  addKMLRowsToMap(map, window.kmlResultEnd || [], { preserveExisting: true });

  if (!Object.keys(map).length && Array.isArray(window.kmlResult)) {
    addKMLRowsToMap(map, window.kmlResult || [], {
      preserveExisting: false,
    });
  }

  return map;
}

function mergeKMLResults(startRows = [], endRows = []) {
  return [...(startRows || []), ...(endRows || [])];
}

function normalizeCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function normalizeKey(key) {
  return String(key || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function getFallbackValue(row, keys = []) {
  if (!row || typeof row !== "object") return "";

  const normalizedKeys = keys
    .filter((key) => key !== undefined && key !== null)
    .map((key) => normalizeKey(key));

  const rowEntries = Object.entries(row);

  for (const key of normalizedKeys) {
    const match = rowEntries.find(
      ([entryKey]) => normalizeKey(entryKey) === key,
    );

    if (!match) continue;

    const value = match[1];
    if (value === null || value === undefined) continue;

    const text = String(value).trim();

    if (text) return value;
  }

  return "";
}

function buildDynamicStatusMap() {
  const map = {};
  const source = [
    ...(Array.isArray(window.foremanData) ? window.foremanData : []),
    ...(Array.isArray(window.komdisData) ? window.komdisData : []),
    ...(Array.isArray(window.uploadedData?.foreman)
      ? window.uploadedData.foreman
      : []),
    ...(Array.isArray(window.uploadedData?.komdis)
      ? window.uploadedData.komdis
      : []),
  ];

  normalizeSource(source).forEach((row) => {
    const code = normalizeCode(row["Code Unit MCR"] || row["Code Unit"]);

    if (!code) return;

    const current = map[code] || {};

    map[code] = {
      ...current,
      Category: current.Category || String(row["Category"] || "").trim() || "",
      "Item Category":
        current["Item Category"] ||
        String(row["Item Category"] || "").trim() ||
        "",
      Remarks: current.Remarks || String(row["Remarks"] || "").trim() || "",
      Location: current.Location || String(row["Location"] || "").trim() || "",
      "Working Area":
        current["Working Area"] ||
        String(row["Working Area"] || "").trim() ||
        "",
      "Working Section":
        current["Working Section"] ||
        String(row["Working Section"] || "").trim() ||
        "",
      "Cut Off Report":
        current["Cut Off Report"] ||
        String(row["Cut Off Report"] || "").trim() ||
        "",
    };
  });

  return map;
}

// =========================
// BUILD MASTER MAP
// =========================
function buildMasterMap() {
  let map = {};

  (window.uploadedData?.masterUnit || []).forEach((row) => {
    const codeKey = findKey(row, ["code unit mcr", "code unit"]);
    const classKey =
      findKey(row, ["class unit", "unit class"]) || findKey(row, ["class"]);
    const populasiKey = findKey(row, ["populasi", "population"]);
    const companyKey = findKey(row, ["company", "contractor"]);

    const code = normalizeCode(
      getFallbackValue(row, [codeKey, "Code Unit MCR", "Code Unit"]),
    );

    if (!code) return;

    const equipmentKey = findKey(row, ["equipment", "eqp"]);

    map[code] = {
      equipment: getFallbackValue(row, [
        equipmentKey,
        "Equipment",
        "equipment",
      ]),
      classUnit: getFallbackValue(row, [classKey, "Class Unit", "class unit"]),
      populasi: getFallbackValue(row, [populasiKey, "Populasi", "populasi"]),
      company: String(
        getFallbackValue(row, [companyKey, "Company", "company"]) || "",
      ).trim(),
    };
  });

  return map;
}

// CONECT LOCATION KML
function normalizeLocation(str) {
  return String(str || "")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function buildLocationMap() {
  const map = {};

  const master =
    window.uploadedData?.masterUnit?.master ||
    window.uploadedData?.master ||
    [];

  master.forEach((row) => {
    const lokasiKey = findKey(row, ["lokasi"]);
    const areaKey = findKey(row, ["working area"]);
    const sectionKey = findKey(row, ["working section"]);
    const categoryKey = findKey(row, ["category"]);
    const materialKey = findKey(row, ["description"]);
    const abcKey = findKey(row, ["abc"]);

    if (!lokasiKey) return;

    const lokasiRaw = String(row[lokasiKey] || "").trim();
    if (!lokasiRaw) return;

    const key = normalizeLocation(lokasiRaw);

    map[key] = {
      location: lokasiRaw,
      workingArea: areaKey ? row[areaKey] : "",
      workingSection: sectionKey ? row[sectionKey] : "",
      material: materialKey ? row[materialKey] : "",
      abcCc: abcKey ? row[abcKey] : "",
      categoryBd: categoryKey ? row[categoryKey] : "",
    };
  });

  return map;
}

// =========================
// BUILD REPORT ROWS
// =========================
function buildReportStatusRows(
  source,
  masterMap,
  kmlMap,
  locationMap,
  dynamicMap = {},
) {
  source = normalizeSource(source);

  return source
    .map((row) => {
      const newRow = {};

      REPORT_STATUS_COLUMNS.forEach((col) => {
        newRow[col] = "";
      });

      const code = normalizeCode(
        getFallbackValue(row, ["Code Unit MCR", "Code Unit"]),
      );
      const master = masterMap[code] || {};
      const kml = kmlMap[code] || {};
      const dynamic = dynamicMap[code] || {};

      const equipment =
        getFallbackValue(master, ["equipment"]) ||
        getFallbackValue(row, ["Equipment", "equipment"]);
      const classUnit =
        getFallbackValue(master, ["classUnit"]) ||
        getFallbackValue(row, ["Class Unit", "class unit"]);
      const populasi =
        getFallbackValue(master, ["populasi"]) ||
        getFallbackValue(row, ["Populasi", "populasi"]);
      const company = String(
        getFallbackValue(master, ["company"]) ||
          getFallbackValue(row, ["Company", "company"]) ||
          "",
      ).trim();

      newRow["Code Unit"] = code;
      newRow["Equipment"] = equipment || "";
      newRow["Class Unit"] = classUnit || "";
      newRow["Populasi"] = populasi || 0;

      const hasKmlData = Boolean(kml.location || kml.category);

      if (!hasKmlData) {
        newRow["Category"] = "";
        newRow["Item Category"] = "";
        newRow["Location"] = "";
        newRow["Working Area"] = "";
        newRow["Working Section"] = "";
        newRow["Remarks"] = "";
        newRow["Material"] = "";
        newRow["Category BD"] = "";
        newRow["ABC - CC"] = "";
        newRow["Cut Off Report"] = "";
      } else {
        const locKey = normalizeLocation(
          dynamic.Location || kml.location || "",
        );
        const locMaster = locationMap[locKey] || {};

        newRow["Category"] = buildReportCategory(
          dynamic["Item Category"] || "",
          dynamic.Category || kml.category || "",
          kml.category,
        );
        // 🔥 Jika KML Category = R (Working), gunakan ITEM CATEGORY dari lookup
        // Jika tidak, gunakan logic biasa
        const kmlItemCategory = kml.itemCategory || "";
        const useKmlItemCategory =
          kml.category === "Working" && kmlItemCategory && !dynamic["Item Category"];

        newRow["Item Category"] = normalizeItemCategoryDisplay(
          dynamic["Item Category"] ||
            (useKmlItemCategory
              ? kmlItemCategory
              : mapKmlItemCategory(kml.category)) ||
            "",
        );
        newRow["Location"] =
          kml.location || locMaster.location || dynamic.Location || "";
        newRow["Working Area"] =
          dynamic["Working Area"] || locMaster.workingArea || "";
        newRow["Working Section"] =
          dynamic["Working Section"] || locMaster.workingSection || "";
        newRow["Remarks"] = dynamic.Remarks || "";
        newRow["Material"] = mapItemCategoryToMaterial(newRow["Item Category"]);
        newRow["Category BD"] = "";
        newRow["ABC - CC"] = "";
        newRow["Cut Off Report"] = dynamic["Cut Off Report"] || "";
      }

      newRow.__company = company;
      newRow.__hasPopulation = String(populasi).trim() !== "";

      return newRow;
    })
    .filter((row) => {
      const population = Number(row["Populasi"]);

      if (!Number.isFinite(population)) {
        return true;
      }

      return population === 1;
    })
    .filter((row) => {
      if (!row.__company) return true;

      return !EXCLUDED_COMPANIES.includes(row.__company);
    })
    .map((row) => {
      delete row.__company;
      delete row.__hasPopulation;

      return row;
    });
}

// Short Code Unit
function sortCodeUnit(a, b) {
  const aParts = String(a["Code Unit"] || "")
    .toUpperCase()
    .split("-");
  const bParts = String(b["Code Unit"] || "")
    .toUpperCase()
    .split("-");

  // safety check (harus 5 segmen)
  if (aParts.length !== 5 || bParts.length !== 5) {
    return (a["Code Unit"] || "").localeCompare(b["Code Unit"] || "");
  }

  const [a1, a2, a3, a4, a5] = aParts;
  const [b1, b2, b3, b4, b5] = bParts;

  // 1. BSS vs CAT
  if (a1 !== b1) return a1.localeCompare(b1);

  // 2. DT vs EX
  if (a2 !== b2) return a2.localeCompare(b2);

  // 3. XC vs YC
  if (a3 !== b3) return a3.localeCompare(b3);

  // 4. 030 vs 005
  const aNum1 = parseInt(a4, 10);
  const bNum1 = parseInt(b4, 10);
  if (aNum1 !== bNum1) return aNum1 - bNum1;

  // 5. 005 vs 010 (final sorting utama)
  const aNum2 = parseInt(a5, 10);
  const bNum2 = parseInt(b5, 10);
  return aNum2 - bNum2;
}

// HELPER ROW
function ensureMinimumRows(data, minRows = 5) {
  const grouped = {};

  data.forEach((row) => {
    const code = row["Code Unit"];

    if (!grouped[code]) {
      grouped[code] = [];
    }

    grouped[code].push(row);
  });

  const result = [];

  Object.values(grouped).forEach((rows) => {
    // simpan row asli semua
    result.push(...rows);

    const need = Math.max(0, minRows - rows.length);

    for (let i = 0; i < need; i++) {
      const base = rows[0];

      const emptyRow = {};

      REPORT_STATUS_COLUMNS.forEach((col) => {
        emptyRow[col] = "";
      });

      // hanya copy identitas unit dan metadata report
      emptyRow["Code Unit"] = base["Code Unit"];
      emptyRow["Equipment"] = base["Equipment"];
      emptyRow["Category"] = base["Category"];
      emptyRow["Working Area"] = base["Working Area"];
      emptyRow["Working Section"] = base["Working Section"];
      emptyRow["Location"] = base["Location"];
      emptyRow["Class Unit"] = base["Class Unit"];
      emptyRow["Populasi"] = base["Populasi"];
      emptyRow["ABC - CC"] = base["ABC - CC"];
      emptyRow["Date"] = base["Date"];
      emptyRow["Shift"] = base["Shift"];
      emptyRow["Cut Off Report"] = base["Cut Off Report"];
      emptyRow["Time Total"] = 0;

      result.push(emptyRow);
    }
  });

  return result;
}

function buildDynamicTimeline(
  code,
  baseShift,
  overridesMap,
  kmlOverridesMap,
  kmlMeta,
) {
  const kmlOverrides =
    kmlOverridesMap && kmlOverridesMap[code]?.length
      ? kmlOverridesMap[code]
      : [];
  const sourceOverrides = overridesMap[code] || [];

  // 🔥 FIX: Gabungkan KML overrides dengan source overrides (komdis/foreman)
  // Prioritaskan source overrides untuk tracking KOMDIS, tapi gunakan KML untuk waktu
  let overrides = [...(kmlOverrides || []), ...(sourceOverrides || [])];

  // 🔥 ADD WAITING BLASTING: Insert Waiting Blasting slot for Shift 1
  // Check if this unit has matching location and waiting blasting mode is active
  const selectedShift = document.getElementById("reportShift")?.value || "";
  if (waitingBlastingMode && selectedShift === "Shift 1") {
    // Check if location matches selected locations (or all if no filter)
    const location = kmlMeta.location || "";
    const locationMatches = waitingBlastingLocations.length === 0 || 
      waitingBlastingLocations.some(selectedLoc => location.toLowerCase().includes(selectedLoc.toLowerCase()));
    
    if (locationMatches) {
      overrides.push({
        start: "16:00",
        end: "17:00",
        type: "Waiting Blasting",
        category: "Standby",
        remarks: "",
        location: location,
        source: "SYSTEM",
      });
    }
  }

  overrides = overrides.length
    ? mergeTimeline(baseShift, overrides).map((slot) => {
        return {
          start: slot.start,
          end: slot.end,
          type: slot.type || "",
          category: slot.category || kmlMeta.category || "",
          overrideType: slot.type || "",
          remarks: slot.remarks || "",
          location: slot.location || "",
          source: slot.source || "",
        };
      })
    : baseShift.map((slot) => ({
        start: slot.start,
        end: slot.end,
        type: slot.type,
        category: kmlMeta.category || "",
        overrideType: slot.type,
        remarks: "",
        location: "",
        source: "",
      }));

  return capTimelineActivitySlots(overrides);
}

function resolveKmlLocationForSlot(
  kmlMeta = {},
  slot = {},
  selectedShift = "",
) {
  const fallback = String(kmlMeta.location || "").trim();
  const startLocation = String(kmlMeta.startLocation || "").trim();
  const endLocation = String(kmlMeta.endLocation || "").trim();

  const slotStart = toMinutes(slot.start || "");
  const slotEnd = toMinutes(slot.end || "");

  if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd)) {
    return fallback;
  }

  const shift1StartBoundary = toMinutes("13:00");
  const shift2StartBoundary = toMinutes("18:00");
  const shift2EndBoundary = toMinutes("06:00");

  if (selectedShift === "Shift 1") {
    if (slotEnd <= shift1StartBoundary) {
      return startLocation || fallback;
    }

    return endLocation || startLocation || fallback;
  }

  if (selectedShift === "Shift 2") {
    if (slotStart >= shift2StartBoundary) {
      return startLocation || fallback;
    }

    if (slotStart >= toMinutes("01:00") && slotEnd <= shift2EndBoundary) {
      return endLocation || startLocation || fallback;
    }

    return startLocation || endLocation || fallback;
  }

  return endLocation || startLocation || fallback;
}

function getCutOffReportLabel(selectedShift, startTime) {
  if (!startTime) {
    if (selectedShift === "Shift 2") return "End of Shift 2";
    return "End of Shift 1";
  }

  const startMin = toMinutes(startTime);

  if (selectedShift === "Shift 1") {
    if (startMin >= toMinutes("06:00") && startMin < toMinutes("13:00")) {
      return "Start of Shift 1";
    }
    return "End of Shift 1";
  }

  if (selectedShift === "Shift 2") {
    if (startMin >= toMinutes("18:00") || startMin < toMinutes("01:00")) {
      return "Start of Shift 2";
    }
    return "End of Shift 2";
  }

  return "";
}

function normalizeStandbyTrigger(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

function isStandbyTriggerItemCategory(itemCategory) {
  const normalized = normalizeStandbyTrigger(itemCategory);

  return (
    normalized.includes("NR") ||
    normalized.includes("NO OPERATOR") ||
    normalized.includes("NO JOB")
  );
}

function resolveReportCategory(itemCategory, fallbackCategory) {
  if (
    ["Meal and Rest", "Change Shift"].includes(itemCategory) ||
    isStandbyTriggerItemCategory(itemCategory) ||
    itemCategory === "Waiting Blasting"
  ) {
    return "Standby";
  }

  return fallbackCategory || "";
}

function normalizeItemCategoryDisplay(itemCategory) {
  const normalized = String(itemCategory || "").trim();

  if (!normalized) return "";

  if (normalized.toUpperCase() === "NR") return "No Operator";

  return normalized;
}

function mapKmlItemCategory(kmlCategory) {
  const normalized = String(kmlCategory || "").trim();

  if (normalized === "No Operator") return "No Operator";
  if (normalized === "No Job") return "No Job";
  if (normalized === "Breakdown") return "Breakdown";
  if (normalized === "BD Unschedule") return "BD Unschedule";

  return "";
}

function mapItemCategoryToMaterial(itemCategory) {
  const normalized = String(itemCategory || "")
    .trim()
    .toUpperCase();

  // Extract prefix before hyphen or space (e.g., "RK-Hauling" -> "RK")
  const prefix = normalized.split(/[-\s]/)[0];

  if (prefix === "RK") return "Rock";
  if (prefix === "SL") return "Soil";
  if (prefix === "BS") return "Biomas";
  if (prefix === "SS") return "Sand";

  return "";
}

function resolveItemCategory(itemCategory, category, kmlCategory = "") {
  const normalizedItemCategory = normalizeItemCategoryDisplay(itemCategory);
  const normalizedCategory = String(category || "").trim();
  const normalizedKmlCategory = mapKmlItemCategory(kmlCategory);

  const kmlDerivedItemCategory =
    normalizedKmlCategory ||
    (["No Operator", "No Job", "Breakdown"].includes(normalizedCategory)
      ? normalizedCategory
      : "");

  if (normalizedItemCategory === "Activity" && kmlDerivedItemCategory) {
    return kmlDerivedItemCategory;
  }

  if (normalizedItemCategory) {
    return normalizedItemCategory;
  }

  if (kmlDerivedItemCategory) {
    return kmlDerivedItemCategory;
  }

  return normalizedCategory || "";
}

function buildReportCategory(itemCategory, fallbackCategory, kmlCategory = "") {
  const normalizedKmlCategory = String(kmlCategory || "").trim();

  if (
    normalizedKmlCategory === "Breakdown" ||
    normalizedKmlCategory === "BD Unschedule"
  ) {
    return "Breakdown";
  }

  if (["No Operator", "No Job"].includes(normalizedKmlCategory)) {
    return "Standby";
  }

  return resolveReportCategory(itemCategory, fallbackCategory);
}

// REPORT DATE AND SHIFT
function updateReportDate() {
  const input = document.getElementById("reportDatePicker");

  const preview = document.getElementById("reportDatePreview");

  if (!input.value) return;

  const d = new Date(input.value);

  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const day = String(d.getDate()).padStart(2, "0");

  const result = `${day}-${month[d.getMonth()]}-${d.getFullYear()}`;

  if (preview) {
    preview.innerText = result;
  }

  window.selectedReportDate = result;
}

function buildReportStatusPopulationSummary(masterUnit = [], kmlMap = {}) {
  const normalized = normalizeSource(masterUnit);
  const uniqueCodes = new Set();

  normalized.forEach((row) => {
    const code = normalizeCode(
      row?.["Code Unit MCR"] ?? row?.["code unit mcr"] ?? "",
    );

    if (!code) return;

    const company = String(
      getFallbackValue(row, ["Company", "company"]) || "",
    ).trim();
    const population = Number(
      getFallbackValue(row, ["Populasi", "populasi", "population"]),
    );

    if (EXCLUDED_COMPANIES.includes(company)) return;
    if (!Number.isFinite(population) || population !== 1) return;

    uniqueCodes.add(code);
  });

  let filledKml = 0;

  Array.from(uniqueCodes).forEach((code) => {
    const kmlMeta = kmlMap[code] || {};

    if (String(kmlMeta.location || "").trim()) {
      filledKml += 1;
    }
  });

  return {
    total: uniqueCodes.size,
    filledKml,
    empty: Math.max(uniqueCodes.size - filledKml, 0),
  };
}

// =========================
// PROCESS
// =========================

// Helper: extract Google Drive file ID from various link formats
function extractDriveFileId(url) {
  if (!url) return null;
  const s = String(url).trim();
  const patterns = [/\/d\/([a-zA-Z0-9_-]{10,})/, /id=([a-zA-Z0-9_-]{10,})/, /open\?id=([a-zA-Z0-9_-]{10,})/];
  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1];
  }

  // plain id
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;

  return null;
}

// Load an .xlsx file or Google Sheets CSV from a public link and store into window.uploadedData
async function loadExcelFromDrive() {
  const link = document.getElementById("driveLinkInput")?.value || "";
  const target = document.getElementById("driveTarget")?.value || "activity";
  const statusEl = document.getElementById("driveLoadStatus");

  console.log("🔄 loadExcelFromDrive START - target:", target);

  if (!link) {
    if (statusEl) statusEl.textContent = "Paste Drive/Sheets link or file id first.";
    return;
  }

  const id = extractDriveFileId(link) || link;
  if (!id) {
    if (statusEl) statusEl.textContent = "Invalid Drive/Sheets link or file id.";
    return;
  }

  // Detect Google Sheets URL
  const isSheets = /docs\.google\.com\/spreadsheets/.test(link);

  try {
    if (statusEl) statusEl.textContent = "Loading...";

    if (isSheets) {
      // extract gid if present
      const gidMatch = String(link).match(/[?&]gid=(\d+)/);
      const gid = gidMatch ? gidMatch[1] : "0";
      const csvUrl = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;

      const res = await fetch(csvUrl);
      if (!res.ok) throw new Error(`Fetch failed (${res.status})`);

      const text = await res.text();

      const parsedHeader = Papa.parse(text, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => String(h || "").trim().replace(/^\uFEFF/, ""),
      });
      const parsed = parsedHeader.data || [];
      const fields = parsedHeader.meta && parsedHeader.meta.fields ? parsedHeader.meta.fields : [];
      const dataArray = Papa.parse(text, { skipEmptyLines: true }).data || [];

      window.uploadedData = window.uploadedData || {};

      if (target === "reportStatus") {
        const rowsFromHeader = parsed.map((row) => {
          const normalized = {};
          REPORT_STATUS_COLUMNS.forEach((col) => {
            let v = row[col];
            if (v === undefined || v === null) v = "";
            if (typeof v === "string") v = v.trim();
            normalized[col] = v;
          });
          return normalized;
        });

        const headerRow = dataArray[0] || [];
        const headerMap = {};
        headerRow.forEach((h, idx) => {
          headerMap[normalizeKey(h)] = idx;
        });

        const rowsFromArray = dataArray.slice(1).map((row) => {
          const normalized = {};
          REPORT_STATUS_COLUMNS.forEach((col) => {
            const idx = headerMap[normalizeKey(col)];
            let v = idx !== undefined && idx >= 0 ? row[idx] : "";
            if (v === undefined || v === null) v = "";
            if (typeof v === "string") v = v.trim();
            normalized[col] = v;
          });
          return normalized;
        });

        const hasHeaderData = rowsFromHeader.length > 0 && Object.values(rowsFromHeader[0]).some((v) => String(v).trim() !== "");
        reportStatusData = hasHeaderData ? rowsFromHeader : rowsFromArray;

        // 🔥 VALIDASI: pastikan data loaded adalah array dan punya isi
        if (!Array.isArray(reportStatusData)) {
          throw new Error("Failed to parse spreadsheet: reportStatusData is not an array");
        }

        // 🔥 UPDATE SUMMARY untuk load mode
        reportStatusSummary = {
          total: reportStatusData.length,
          filledKml: 0, // dalam load mode, kita tidak tahu berapa filled dari KML
          empty: 0,
        };

        // 🔥 SET MODE TO LOAD (jangan auto-trigger generate)
        reportStatusMode = "load";
        reportStatusSourceInfo = {
          type: "spreadsheet",
          rows: reportStatusData.length,
          columns: fields.length,
        };

        window.uploadedData.reportStatus = reportStatusData;
        if (statusEl) {
          const sampleCols = fields.slice(0, 5).join(", ");
          statusEl.textContent = `Loaded Google Sheets report status → ${reportStatusData.length} rows; ${fields.length} columns (${sampleCols}${fields.length > 5 ? ", ..." : ""})`;
        }
        console.log("✓ reportStatus LOAD MODE - data ready:", reportStatusData.length, "rows");
        console.log("reportStatusData sample", reportStatusData.slice(0, 3));
        
        // 🔥 RENDER hanya setelah data FULLY READY
        renderReportStatusTable(reportStatusData);
      } else {
        // merge with existing if possible (preserve previous uploads)
        const existing = window.uploadedData[target];
        if (Array.isArray(existing) && Array.isArray(dataArray) && existing.length && dataArray.length) {
          // assume first row is header; append rows after header
          const toAppend = dataArray.length > 1 ? dataArray.slice(1) : [];
          window.uploadedData[target] = existing.concat(toAppend);
        } else {
          window.uploadedData[target] = dataArray;
        }

        if (statusEl) statusEl.textContent = `Loaded Google Sheets (CSV) → ${dataArray.length - 1} rows into ${target}`;

        // update convenience globals used elsewhere
        if (target === "foreman") window.foremanData = window.uploadedData.foreman;
        if (target === "komdis") window.komdisData = window.uploadedData.komdis;

        // update status UI if available
        try {
          if (typeof status !== "undefined") {
            status[target] = "Uploaded ✔";
            if (typeof updateStatusUI === "function") updateStatusUI();
          }
        } catch (e) {
          /* ignore */
        }
      }

      // persist state so previous uploads are not lost on reload
      if (typeof window.persistAppState === "function") window.persistAppState();
    } else {
      // fallback to Drive file download (xlsx)
      const url = `https://drive.google.com/uc?export=download&id=${id}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Fetch failed (${res.status})`);

      const ab = await res.arrayBuffer();

      const workbook = XLSX.read(ab, { type: "array" });
      const sheetNames = workbook.SheetNames || [];
      const result = {};
      sheetNames.forEach((name) => {
        const ws = workbook.Sheets[name];
        const arr = XLSX.utils.sheet_to_json(ws, { header: 1 });
        result[name] = arr;
      });

      const firstSheet = sheetNames[0];
      const dataArray = result[firstSheet] || [];

      window.uploadedData = window.uploadedData || {};

      const existing = window.uploadedData[target];
      if (Array.isArray(existing) && Array.isArray(dataArray) && existing.length && dataArray.length) {
        const toAppend = dataArray.length > 1 ? dataArray.slice(1) : [];
        window.uploadedData[target] = existing.concat(toAppend);
      } else {
        window.uploadedData[target] = dataArray;
      }

      if (statusEl) statusEl.textContent = `Loaded sheet ${firstSheet} → ${dataArray.length - 1} rows into ${target}`;

      if (target === "foreman") window.foremanData = window.uploadedData.foreman;
      if (target === "komdis") window.komdisData = window.uploadedData.komdis;

      if (typeof window.persistAppState === "function") window.persistAppState();
      try {
        if (typeof status !== "undefined") {
          status[target] = "Uploaded ✔";
          if (typeof updateStatusUI === "function") updateStatusUI();
        }
      } catch (e) {
        /* ignore */
      }
    }

    // If we loaded critical data that processReportStatus expects, re-run it
    // TAPI: hanya kalau kita sedang dalam mode GENERATE (bukan LOAD)
    // User harus eksplisit click "Generate Report Status" button
    if (["masterUnit", "komdis", "foreman", "activity"].includes(target)) {
      if (reportStatusMode === "generate") {
        try {
          processReportStatus();
        } catch (e) {
          console.warn("processReportStatus failed after load:", e);
        }
      }
    }
  } catch (err) {
    console.error("❌ loadExcelFromDrive ERROR:", err);
    if (statusEl) statusEl.textContent = "❌ Error loading file: " + err.message + ". CORS or file visibility may block direct download.";
  }
}

function processReportStatus() {
  // 🔥 SET MODE TO GENERATE
  reportStatusMode = "generate";
  reportStatusSourceInfo = {
    type: "generated",
    sources: ["master", "foreman", "komdis", "kml"],
    timestamp: new Date().toISOString(),
  };

  reportStatusData = [];
  reportStatusCurrentPage = 1;

  if (typeof window.restorePersistedState === "function") {
    const currentMasterUnit =
      window.uploadedData?.masterUnit?.masterUnit ||
      window.uploadedData?.masterUnit ||
      [];

    if (!Array.isArray(currentMasterUnit) || currentMasterUnit.length === 0) {
      window.restorePersistedState();
    }
  }

  const masterUnit =
    window.uploadedData?.masterUnit?.masterUnit ||
    window.uploadedData?.masterUnit ||
    [];

  const selectedDate = window.selectedReportDate || "";
  const selectedShift = document.getElementById("reportShift")?.value || "";

  const kmlMap = buildKMLMap();
  const dynamicMap = buildDynamicStatusMap();

  const komdisSource =
    Array.isArray(window.komdisData) && window.komdisData.length
      ? window.komdisData
      : window.uploadedData?.komdis || [];

  const komdisCodeSet = new Set(
    normalizeSource(komdisSource).map((r) =>
      normalizeCode(r["Code Unit MCR"] || r["Code Unit"]),
    ),
  );

  reportStatusSummary = buildReportStatusPopulationSummary(masterUnit, kmlMap);

  const rows = buildReportStatusRows(
    masterUnit,
    buildMasterMap(),
    kmlMap,
    buildLocationMap(),
    dynamicMap,
  );

  const baseShift = getShiftBase(selectedShift);
  const foremanSource =
    Array.isArray(window.foremanData) && window.foremanData.length
      ? window.foremanData
      : window.uploadedData?.foreman || [];
  const overridesMap = buildOverrides(
    [...komdisSource, ...foremanSource],
    komdisCodeSet,
  );
  const kmlOverridesMap = buildKMLOverrideMap(
    selectedShift,
    window.kmlResultStart || [],
    window.kmlResultEnd || [],
  );

  const finalRows = rows.flatMap((row) => {
    const code = String(row["Code Unit"] || "")
      .trim()
      .toUpperCase();

    const kmlMeta = kmlMap[code] || {};
    const hasKmlData = Boolean(kmlMeta.location || kmlMeta.category);
    const baseRow = {
      ...row,
      Date: selectedDate,
      Shift: selectedShift,
    };

    if (!hasKmlData) {
      return [
        {
          ...baseRow,
          Category: "",
          "Item Category": "",
          "Working Area": "",
          "Working Section": "",
          Before: "",
          After: "",
          "Time Total": 0,
          Location: "",
          Remarks: "",
          Material: "",
          "Category BD": "",
          "Cut Off Report": getCutOffReportLabel(selectedShift),
          "ABC - CC": "",
        },
      ];
    }

    const timeline = buildDynamicTimeline(
      code,
      baseShift,
      overridesMap,
      kmlOverridesMap,
      kmlMeta,
    );

    return timeline.map((t) => {
      const category = buildReportCategory(
        t.type || t.overrideType || row["Category"] || "",
        row["Category"] || kmlMeta.category || "",
        t.overrideType || kmlMeta.category,
      );

      const kmlLocation = resolveKmlLocationForSlot(kmlMeta, t, selectedShift);

      // 🔥 Jika KML Category = R (Working) dan slot type = Activity,
      // gunakan ITEM CATEGORY dari lookup KML sesuai sumber (start/end)
      // Level 2 (start time) → startItemCategory dari Equipment Coordinate Start
      // Level 4 (end time) → endItemCategory dari Equipment Coordinate End
      let itemCategoryType = t.type || "";

      if (
        kmlMeta.category === "Working" &&
        t.type === "Activity" &&
        t.source !== "KOMDIS"
      ) {
        const slotStartMin = toMinutes(t.start || "");
        const slotEndMin = toMinutes(t.end || "");

        // Tentukan apakah slot ini di waktu start atau end berdasarkan shift
        // Jika kedua slot punya item category, gunakan nilai masing-masing.
        // Hanya fallback ke pasangan ketika nilai yang diharapkan kosong.
        let useStartItemCategory = false;

        if (selectedShift === "Shift 1") {
          // Shift 1: start = 06:30-12:00, end = 13:00-17:30
          useStartItemCategory = slotEndMin <= toMinutes("12:00");
        } else if (selectedShift === "Shift 2") {
          // Shift 2: start = 18:30-00:00, end = 01:00-05:30
          useStartItemCategory =
            slotStartMin >= toMinutes("18:00") ||
            slotEndMin <= toMinutes("00:00");
        }

        let chosenItemCategory = useStartItemCategory
          ? kmlMeta.startItemCategory
          : kmlMeta.endItemCategory;

        if (!chosenItemCategory) {
          chosenItemCategory = useStartItemCategory
            ? kmlMeta.endItemCategory
            : kmlMeta.startItemCategory;
        }

        if (chosenItemCategory) {
          itemCategoryType = chosenItemCategory;
        }
      }

      const resolvedType = isSystemSlot(t.type) ? itemCategoryType : t.type;

      const itemCategory = resolveItemCategory(
        resolvedType,
        category,
        kmlMeta.category,
      );

return {
         ...baseRow,

         Category: category,

         "Item Category": itemCategory,

         Material: mapItemCategoryToMaterial(itemCategory),

         Location: t.location || kmlLocation || baseRow.Location || "",

         Before: t.start || "",

         After: t.end || "",

         "Time Total": getTimeTotal(t.start, t.end),

         "Cut Off Report": getCutOffReportLabel(selectedShift, t.start),

         // 🔥 SOURCE TRACKING
         __source: t.source || "",
       };
    });
  });

  reportStatusData = ensureMinimumRows(finalRows);

  reportStatusData.sort(sortCodeUnit);

  // 🔥 VALIDASI: pastikan data generate punya isi sebelum render
  if (!Array.isArray(reportStatusData) || reportStatusData.length === 0) {
    console.warn("⚠ Generate mode: no data after processing");
  } else {
    console.log("✓ reportStatus GENERATE MODE - data ready:", reportStatusData.length, "rows");
  }

  renderReportStatusTable(reportStatusData);
}

// =========================
// TABLE
// =========================

function changeReportStatusPage(page) {
  const totalPages = Math.max(
    1,
    Math.ceil(reportStatusData.length / REPORT_STATUS_ROWS_PER_PAGE),
  );
  const nextPage = Math.min(Math.max(1, page), totalPages);

  reportStatusCurrentPage = nextPage;
  renderReportStatusTable(reportStatusData);
}

function renderReportStatusPagination(totalPages) {
  const pagination = document.getElementById("reportStatusPagination");

  if (!pagination) return;

  if (totalPages <= 1) {
    pagination.innerHTML = "";
    return;
  }

  let html = `
    <button ${reportStatusCurrentPage === 1 ? "disabled" : ""} onclick="changeReportStatusPage(${reportStatusCurrentPage - 1})">
      ‹
    </button>
  `;

  for (let i = 1; i <= totalPages; i += 1) {
    html += `
      <button class="${i === reportStatusCurrentPage ? "active" : ""}" onclick="changeReportStatusPage(${i})">
        ${i}
      </button>
    `;
  }

  html += `
    <button ${reportStatusCurrentPage === totalPages ? "disabled" : ""} onclick="changeReportStatusPage(${reportStatusCurrentPage + 1})">
      ›
    </button>
  `;

  pagination.innerHTML = html;
}

function renderReportStatusTable(data) {
  console.log("🎨 renderReportStatusTable CALLED - data length:", data?.length, "type:", typeof data);
  
  // 🔥 VALIDASI: pastikan data yang dikirim adalah array yang valid
  if (!Array.isArray(data)) {
    console.warn("❌ renderReportStatusTable: data is not an array", data);
    const container = document.getElementById("reportStatusResult");
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <div>Data tidak valid atau belum tersedia</div>
          <div style="font-size: 0.8em; color: #999; margin-top: 8px;">Data type: ${typeof data}</div>
        </div>
      `;
    }
    return;
  }

  const container = document.getElementById("reportStatusResult");
  const info = document.getElementById("reportStatusInfo");

  if (!container) {
    console.warn("❌ renderReportStatusTable: container not found");
    return;
  }

  // =========================
  // EMPTY
  // =========================
  if (!data.length) {
    console.log("ℹ️ renderReportStatusTable: data is empty");
    const hasActiveFilters = (typeof reportStatusFilters !== 'undefined') && reportStatusFilters.some((v) => Boolean(v));
    container.innerHTML = `
      <div class="empty-state">
        <div>Tidak ada data</div>
        ${hasActiveFilters ? `<div class="empty-actions" style="margin-top:8px;"><button class="btn-clear-filters" onclick="clearAllFilters()">Hapus semua filter</button></div>` : ``}
      </div>
    `;

    if (info) info.innerHTML = "";

    const pagination = document.getElementById("reportStatusPagination");

    if (pagination) {
      pagination.innerHTML = "";
    }

    return;
  }

  console.log("✓ renderReportStatusTable: building table with", data.length, "rows");

  // =========================
  // INFO
  // =========================
  if (info) {
    const modeLabel = reportStatusMode === "generate" ? "Generated" : reportStatusMode === "load" ? "Loaded" : "Unknown";
    const modeColor = reportStatusMode === "generate" ? "#4CAF50" : reportStatusMode === "load" ? "#2196F3" : "#999";
    
    info.innerHTML = `
      <span style="color: ${modeColor}; font-weight: bold;">● ${modeLabel}</span>
      •
      Population Total:
      <strong>${reportStatusSummary.total}</strong>
      •

      Filled from KML:
      <strong>${reportStatusSummary.filledKml}</strong>
      •

      Empty:
      <strong>${reportStatusSummary.empty}</strong>
    `;
  }

  // =========================
  // TABLE START
  // =========================
  let html = `
    <table>
      <thead>
        <tr>
  `;

  // HEADER
  const filterOptions = getFilterOptions();

  REPORT_STATUS_COLUMNS.forEach((h, index) => {
    const value = reportStatusFilters[index] || "";
    const options = filterOptions[index] || [];
    const hasActive = Boolean(value);

    html += `
      <th class="filter-cell">
        <div class="header-with-filter ${hasActive ? "active" : ""}">
          <span>${h}</span>
          <button
            class="filter-icon ${hasActive ? "active" : ""}"
            onclick="toggleFilterDropdown(event, ${index})"
            title="Filter ${h}"
          >${hasActive ? "✓" : "≡"}</button>
        </div>
        ${activeFilterIndex === index ? `
<div class="filter-box">
             <input
               type="text"
               class="filter-input"
               placeholder="Filter ${h}"
               data-filter-index="${index}"
               value="${String(value).replace(/"/g, "&quot;")}"
               onchange="handleFilterChange(event)"
             />
              <div class="filter-values">
                ${options
                  .map(
                    (option) => {
                      const safeValue = option === "__BLANK_FILTER__" ? "__BLANK_FILTER__" : String(option).replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                      const displayText = option === "__BLANK_FILTER__" ? "(Blank)" : option;
                      return `
                    <button
                      type="button"
                      class="filter-option"
                      data-filter-index="${index}"
                      data-filter-value="${safeValue}"
                    >${displayText}</button>
                  `;
                    },
                  )
                  .join("")}
            </div>
            <button type="button" class="filter-clear" onclick="clearFilter(${index})">Clear</button>
          </div>
        ` : ""}
      </th>
    `;
  });

  html += `
      <th style="width: 80px; text-align: center;">Action</th>
      <th style="width: 50px; text-align: center;"><input type="checkbox" id="selectAllRows" onchange="toggleSelectAll(this.checked)" title="Select all rows" style="cursor: pointer;"></th>
      <th style="width: 100px; text-align: center;"><button class="btn-delete-selected" onclick="event.stopPropagation(); deleteSelectedRows()" title="Delete selected rows" ${
        selectedRows.size === 0 ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''
      }>🗑 Hapus (${selectedRows.size})</button></th>
        </tr>
      </thead>

      <tbody>
  `;

// =========================
  // ROWS
  // =========================
  const filteredIndices = [];
  data.forEach((row, idx) => {
    const originalIndex = reportStatusData.indexOf(row);
    const isKomdis = row.__source === "KOMDIS";
    filteredIndices.push(originalIndex);
    const isSelected = selectedRows.has(originalIndex);

    html += `
    <tr class="report-row ${isSelected ? "row-selected" : ""}" data-row-index="${originalIndex}" onclick="toggleRowSelect(${originalIndex}, ${idx}, event)">
    `;

    REPORT_STATUS_COLUMNS.forEach((h) => {
      const value = row[h] ?? "";

      html += `
        <td class="${isKomdis && value ? "cell-komdis" : ""}">
          ${value}
        </td>
      `;
    });

    html += `
        <td style="text-align: center;" onclick="event.stopPropagation();">
          <button class="btn-edit" onclick="openEditModal(${originalIndex})" title="Edit row">✎</button>
        </td>
        <td style="text-align: center;" onclick="event.stopPropagation();">
          <input type="checkbox" class="row-checkbox" data-row-index="${originalIndex}" ${isSelected ? "checked" : ""} onchange="toggleRowSelect(${originalIndex}, ${idx}, event)" style="cursor: pointer;">
        </td>
      </tr>
    `;
  });

  // Store rendered indices (filtered position → original index) for shift+click handling
  window._lastRenderedFilteredIndices = filteredIndices;

  // =========================
  // TABLE END
  // =========================
  html += `
      </tbody>
    </table>
  `;

  console.log("✓ renderReportStatusTable: HTML built, rendering to container");
  container.innerHTML = html;
  console.log("✓ renderReportStatusTable: COMPLETE - table rendered successfully");

  // =========================
  // DISABLE PAGINATION
  // =========================
  const pagination = document.getElementById("reportStatusPagination");

  if (pagination) {
    pagination.innerHTML = "";
  }

  // =========================
  // BUTTON VISIBILITY BY MODE
  // =========================
  const exportBtn = document.getElementById("exportReportStatusBtn");
  const exportLoadBtn = document.getElementById("exportReportStatusLoadBtn");
  const addWaitingBlastingBtn = document.getElementById("addWaitingBlastingBtn");
  const selectedShift = document.getElementById("reportShift")?.value || "";

  if (exportBtn) {
    exportBtn.style.display = reportStatusMode === "generate" ? "flex" : "none";
  }

  if (exportLoadBtn) {
    exportLoadBtn.style.display = reportStatusMode === "load" ? "flex" : "none";
  }

  if (addWaitingBlastingBtn) {
    addWaitingBlastingBtn.style.display = reportStatusMode === "generate" ? "flex" : "none";
  }
}

function handleFilterChange(event) {
  const input = event.target;
  const index = Number(input.dataset.filterIndex);
  const value = input.value;

  if (!Number.isFinite(index)) return;

  reportStatusFilters[index] = value;
  renderReportStatusTable(getFilteredReportStatusData());
}

function handleFilterInput(event) {
  const input = event.target;
  const index = Number(input.dataset.filterIndex);
  const value = input.value;

  if (!Number.isFinite(index)) return;

  reportStatusFilters[index] = value;
}

function applyFilterValues() {
  const activeElement = document.activeElement;
  const activeFilterIndex = activeElement?.classList.contains("filter-input") 
    ? Number(activeElement.dataset.filterIndex) 
    : null;
    
  const inputs = document.querySelectorAll(".filter-input");
  inputs.forEach((input) => {
    const index = Number(input.dataset.filterIndex);
    if (!Number.isFinite(index)) return;
    
    // Skip setting value on the active input to preserve cursor position
    if (activeFilterIndex === index && document.activeElement === input) return;
    
    input.value = reportStatusFilters[index] || "";
  });
}

function toggleFilterDropdown(event, index) {
  event.stopPropagation();
  activeFilterIndex = activeFilterIndex === index ? -1 : index;
  renderReportStatusTable(getFilteredReportStatusData());
}

function applyFilterOption(index, value) {
  reportStatusFilters[index] = value;
  activeFilterIndex = -1;
  renderReportStatusTable(getFilteredReportStatusData());
}

function clearFilter(index) {
  reportStatusFilters[index] = "";
  activeFilterIndex = -1;
  renderReportStatusTable(getFilteredReportStatusData());
}

function clearAllFilters() {
  if (!Array.isArray(reportStatusFilters)) return;
  for (let i = 0; i < reportStatusFilters.length; i++) {
    reportStatusFilters[i] = "";
  }
  activeFilterIndex = -1;
  renderReportStatusTable(getFilteredReportStatusData());
}

document.addEventListener("click", (event) => {
  const target = event.target;

  if (target.closest && target.closest(".filter-option")) {
    const button = target.closest(".filter-option");
    const index = Number(button.dataset.filterIndex);
    const value = button.dataset.filterValue;
    if (Number.isFinite(index)) {
      applyFilterOption(index, value);
      return;
    }
  }

  if (!target.closest || !target.closest(".filter-cell")) {
    if (activeFilterIndex !== -1) {
      activeFilterIndex = -1;
      renderReportStatusTable(getFilteredReportStatusData());
    }
  }
});

function getFilterOptions() {
  // For dependent filters: compute available options for each column
  // based on reportStatusData but applying all other active filters.
  const options = REPORT_STATUS_COLUMNS.map(() => new Set());

  REPORT_STATUS_COLUMNS.forEach((column, colIdx) => {
    const partialFiltered = reportStatusData.filter((row) => {
      return reportStatusFilters.every((filterValue, fIdx) => {
        if (!filterValue) return true;
        if (fIdx === colIdx) return true;

        const col = REPORT_STATUS_COLUMNS[fIdx];
        const cell = String(row[col] ?? "").toLowerCase();
        return cell.includes(String(filterValue).toLowerCase());
      });
    });

    let hasBlank = false;

    partialFiltered.forEach((row) => {
      const v = String(row[column] ?? "").trim();
      if (v) {
        options[colIdx].add(v);
      } else {
        hasBlank = true;
      }
    });

    if (hasBlank) {
      options[colIdx].add("__BLANK_FILTER__");
    }
  });

  return options.map((set) =>
    Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  );
}

function getFilteredReportStatusData() {
  return reportStatusData.filter((row) => {
    return reportStatusFilters.every((value, index) => {
      if (!value) return true;

      const column = REPORT_STATUS_COLUMNS[index];
      const cellValue = String(row[column] ?? "");
      const cell = cellValue.toLowerCase();

      if (value === "__BLANK_FILTER__") {
        return cellValue.trim() === "";
      }

      return cell.includes(String(value).toLowerCase());
    });
  });
}

// =========================
// FILTER STATE
// =========================
const reportStatusFilters = Array(REPORT_STATUS_COLUMNS.length).fill("");
let activeFilterIndex = -1;
let filterDebounceTimer = null;

// =========================
// HANDLER
// =========================

async function handleReportStatus() {
  try {
    const master = window.uploadedData?.masterUnit || [];
    const activity = window.uploadedData?.activity || [];

    const eqStartFile = document.getElementById("equipmentCoordinateStartFile")
      ?.files[0];
    const eqEndFile = document.getElementById("equipmentCoordinateEndFile")
      ?.files[0];
    const areaFile = document.getElementById("boundaryKMLFile")?.files[0];

    let missing = [];

    if (!eqStartFile && !eqEndFile)
      missing.push("🗺️ Equipment Coordinate Start/End");
    if (!areaFile) missing.push("🗺️ Boundary");
    if (!master.length) missing.push("🚜 Master Unit");

    if (missing.length) {
      alert(`Upload:\n\n${missing.join("\n")}`);
      return;
    }

    if (eqStartFile) {
      window.kmlResultStart = await processKMLKMZ(
        eqStartFile,
        areaFile,
        master,
        activity,
        "start",
      );
    } else {
      window.kmlResultStart = [];
    }

    if (eqEndFile) {
      window.kmlResultEnd = await processKMLKMZ(
        eqEndFile,
        areaFile,
        master,
        activity,
        "end",
      );
    } else {
      window.kmlResultEnd = [];
    }
    window.kmlResult = mergeKMLResults(
      window.kmlResultStart,
      window.kmlResultEnd,
    );

    processReportStatus();

    alert("PROCESS SUCCESS ✔");
  } catch (err) {
    console.error(err);

    alert("FAILED PROCESS\n\n" + err.message);
  }
}

// =========================
// EDIT MODAL
// =========================
function openEditModal(rowIndex) {
  if (rowIndex < 0 || rowIndex >= reportStatusData.length) return;

  editingRowIndex = rowIndex;
  editingRowData = { ...reportStatusData[rowIndex] };

  const modal = document.getElementById("editRowModal");
  if (!modal) return;

  const form = modal.querySelector(".edit-form");
  if (!form) return;

  form.innerHTML = "";

  REPORT_STATUS_COLUMNS.forEach((col) => {
    const value = editingRowData[col] ?? "";
    const isReadOnly = [
      "Code Unit",
      "Equipment",
      "Class Unit",
      "Populasi",
    ].includes(col);

    form.innerHTML += `
      <div class="form-group">
        <label>${col}</label>
        <input
          type="text"
          class="edit-field"
          data-field="${col}"
          value="${String(value).replace(/"/g, "&quot;")}"
          ${isReadOnly ? "readonly" : ""}
          style="${
            isReadOnly
              ? "background-color: #f5f5f5; cursor: not-allowed;"
              : ""
          }"
        />
      </div>
    `;
  });

  modal.style.display = "block";
}

function closeEditModal() {
  const modal = document.getElementById("editRowModal");
  if (modal) modal.style.display = "none";
  editingRowIndex = -1;
  editingRowData = {};
}

function saveEditModal() {
  if (editingRowIndex < 0 || editingRowIndex >= reportStatusData.length)
    return;

  const form = document.getElementById("editRowModal")?.querySelector(
    ".edit-form",
  );
  if (!form) return;

  const inputs = form.querySelectorAll(".edit-field");
  inputs.forEach((input) => {
    const field = input.dataset.field;
    if (field && !input.readOnly) {
      reportStatusData[editingRowIndex][field] = input.value;
    }
  });

  closeEditModal();
  renderReportStatusTable(reportStatusData);
}

window.openEditModal = openEditModal;
window.closeEditModal = closeEditModal;
window.saveEditModal = saveEditModal;

// =========================
// ROW SELECTION
function toggleRowSelect(originalIndex, filteredPosition, event) {
  if (originalIndex < 0 || originalIndex >= reportStatusData.length) return;
  if (filteredPosition === undefined || filteredPosition === null) return;

  const shiftPressed = event && event.shiftKey;
  const currentSelection = new Set(selectedRows);

  if (shiftPressed && lastSelectedFilteredPosition !== -1 && lastSelectedFilteredPosition !== filteredPosition) {
    const start = Math.min(lastSelectedFilteredPosition, filteredPosition);
    const end = Math.max(lastSelectedFilteredPosition, filteredPosition);
    const renderedIndices = window._lastRenderedFilteredIndices || [];
    for (let pos = start; pos <= end; pos++) {
      if (pos >= 0 && pos < renderedIndices.length) {
        currentSelection.add(renderedIndices[pos]);
      }
    }
    selectedRows = currentSelection;
  } else {
    if (currentSelection.has(originalIndex)) {
      currentSelection.delete(originalIndex);
    } else {
      currentSelection.add(originalIndex);
    }
    selectedRows = currentSelection;
  }

  lastSelectedFilteredPosition = filteredPosition;
  updateSelectAllCheckbox();
  const filteredData = getFilteredReportStatusData();
  renderReportStatusTable(filteredData.length > 0 ? filteredData : reportStatusData);
}

function deleteSelectedRows() {
  if (selectedRows.size === 0) {
    alert("Pilih baris yang ingin dihapus terlebih dahulu");
    return;
  }

  closeEditModal();

  if (!confirm(`Hapus ${selectedRows.size} baris yang dipilih?`)) return;

  const sortedIndices = Array.from(selectedRows).sort((a, b) => b - a);
  sortedIndices.forEach((index) => {
    if (index >= 0 && index < reportStatusData.length) {
      reportStatusData.splice(index, 1);
    }
  });

    selectedRows.clear();
    lastSelectedFilteredPosition = -1;
  updateSelectAllCheckbox();
  const filteredData = getFilteredReportStatusData();
  renderReportStatusTable(filteredData.length > 0 ? filteredData : reportStatusData);
  alert("Baris berhasil dihapus");
}

function toggleSelectAll(isChecked) {
  // Get original indices from the currently rendered (filtered) data
  const indicesToToggle = window._lastRenderedFilteredIndices || [];
  
  if (isChecked) {
    indicesToToggle.forEach((originalIndex) => {
      selectedRows.add(originalIndex);
    });
  } else {
    indicesToToggle.forEach((originalIndex) => {
      selectedRows.delete(originalIndex);
    });
  }

  updateSelectAllCheckbox();
  renderReportStatusTable(getFilteredReportStatusData());
}

function updateSelectAllCheckbox() {
  const selectAllCheckbox = document.getElementById("selectAllRows");
  if (!selectAllCheckbox) return;

  const filteredIndices = window._lastRenderedFilteredIndices || [];
  const totalRows = filteredIndices.length;
  const selectedCount = Array.from(selectedRows).filter(idx => filteredIndices.includes(idx)).length;

  selectAllCheckbox.checked = selectedCount === totalRows && totalRows > 0;
  selectAllCheckbox.indeterminate =
    selectedCount > 0 && selectedCount < totalRows;
}

window.toggleRowSelect = toggleRowSelect;
window.toggleSelectAll = toggleSelectAll;
window.deleteSelectedRows = deleteSelectedRows;

// =========================
// EXPORT (handled by onclick in HTML)
// =========================

function exportReportStatusLoadExcel() {
  if (!reportStatusData.length) {
    alert("Tidak ada data untuk diekspor");
    return;
  }

  const aoa = [];
  aoa.push(REPORT_STATUS_COLUMNS.slice());

  for (let i = 0; i < reportStatusData.length; i++) {
    const row = reportStatusData[i] || {};
    const rowArr = REPORT_STATUS_COLUMNS.map((col) => {
      let v = row[col];
      if (v === null || v === undefined) return "";
      if (typeof v === "object") {
        try {
          v = JSON.stringify(v);
        } catch (e) {
          v = String(v);
        }
      }
      if (typeof v === "string") {
        const trimmed = v.replace(/\u00A0/g, " ").trim();
        if (trimmed === "") return "";
        const num = Number(trimmed);
        if (!Number.isNaN(num)) return num;
        return trimmed;
      }
      return v;
    });

    aoa.push(rowArr);
  }

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
    for (let R = range.s.r; R <= range.e.r; ++R) {
      for (let C = range.s.c; C <= range.e.c; ++C) {
        const cellRef = XLSX.utils.encode_cell({ r: R, c: C });
        const isHeader = R === range.s.r;
        if (!ws[cellRef]) {
          delete ws[cellRef];
        } else {
          const cell = ws[cellRef];
          if (isHeader) {
            ws[cellRef] = { t: "s", v: String(cell.v || "") };
          } else if (cell.v === null || cell.v === undefined || String(cell.v).trim() === "") {
            delete ws[cellRef];
          } else if (typeof cell.v === "number") {
            ws[cellRef] = { t: "n", v: cell.v };
          } else {
            const text = String(cell.v);
            if (text.startsWith("=")) {
              ws[cellRef] = { t: "s", v: text };
            } else {
              ws[cellRef] = { t: "s", v: text };
            }
          }
        }
      }
    }

    let minR = range.s.r;
    let maxR = range.e.r;
    let minC = range.s.c;
    let maxC = range.e.c;
    for (let R = maxR; R >= minR; --R) {
      let hasData = false;
      for (let C = minC; C <= maxC; ++C) {
        if (ws[XLSX.utils.encode_cell({ r: R, c: C })]) {
          hasData = true;
          break;
        }
      }
      if (!hasData) {
        for (let C = minC; C <= maxC; ++C) {
          delete ws[XLSX.utils.encode_cell({ r: R, c: C })];
        }
        maxR = R - 1;
      } else {
        break;
      }
    }
    for (let C = maxC; C >= minC; --C) {
      let hasData = false;
      for (let R = minR; R <= maxR; ++R) {
        if (ws[XLSX.utils.encode_cell({ r: R, c: C })]) {
          hasData = true;
          break;
        }
      }
      if (!hasData) {
        for (let R = minR; R <= maxR; ++R) {
          delete ws[XLSX.utils.encode_cell({ r: R, c: C })];
        }
        maxC = C - 1;
      } else {
        break;
      }
    }
    ws["!ref"] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });

  const beforeColIndex = REPORT_STATUS_COLUMNS.indexOf("Before");
  const afterColIndex = REPORT_STATUS_COLUMNS.indexOf("After");
  for (let R = range.s.r + 1; R <= range.e.r; ++R) {
    if (beforeColIndex >= 0) {
      const beforeCellRef = XLSX.utils.encode_cell({ r: R, c: beforeColIndex });
      const cell = ws[beforeCellRef];
      if (cell && cell.v) {
        const timeStr = String(cell.v).trim();
        const parts = timeStr.split(":").map(Number);
        if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
          const h = parts[0];
          const m = parts[1];
          const timeValue = (h * 60 + m) / (24 * 60);
          ws[beforeCellRef] = { t: "n", v: timeValue, z: "hh:mm" };
        }
      }
    }
    if (afterColIndex >= 0) {
      const afterCellRef = XLSX.utils.encode_cell({ r: R, c: afterColIndex });
      const cell = ws[afterCellRef];
      if (cell && cell.v) {
        const timeStr = String(cell.v).trim();
        const parts = timeStr.split(":").map(Number);
        if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
          const h = parts[0];
          const m = parts[1];
          const timeValue = (h * 60 + m) / (24 * 60);
          ws[afterCellRef] = { t: "n", v: timeValue, z: "hh:mm" };
        }
      }
    }
  }

  ws["!cols"] = REPORT_STATUS_COLUMNS.map((header, ci) => {
    let width = header.length;
    for (let r = 1; r < aoa.length; r++) {
      const v = aoa[r][ci];
      const text = v === undefined || v === null ? "" : String(v);
      const longestLine = text.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
      if (longestLine > width) width = longestLine;
    }
    return { wch: Math.max(12, Math.min(width + 3, 80)) };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Report Status");
  XLSX.writeFile(wb, "Report_Status.xlsx");
}

window.exportReportStatusLoadExcel = exportReportStatusLoadExcel;
window.handleReportStatus = handleReportStatus;
window.deleteSelectedRows = deleteSelectedRows;

function exportReportStatusExcel() {
  if (!reportStatusData.length) {
    alert("Tidak ada data");
    return;
  }

  const aoa = [];
  aoa.push(REPORT_STATUS_COLUMNS.slice());

  for (let i = 0; i < reportStatusData.length; i++) {
    const row = reportStatusData[i] || {};
    const rowArr = REPORT_STATUS_COLUMNS.map((col) => {
      let v = row[col];
      if (v === null || v === undefined) return "";
      if (typeof v === "object") {
        try {
          v = JSON.stringify(v);
        } catch (e) {
          v = String(v);
        }
      }
      if (typeof v === "string") {
        const trimmed = v.replace(/\u00A0/g, " ").trim();
        if (trimmed === "") return "";
        const num = Number(trimmed);
        if (!Number.isNaN(num)) return num;
        return trimmed;
      }
      return v;
    });

    aoa.push(rowArr);
  }

  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
  for (let R = range.s.r; R <= range.e.r; ++R) {
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cellRef = XLSX.utils.encode_cell({ r: R, c: C });
      const isHeader = R === range.s.r;
      if (!ws[cellRef]) {
        delete ws[cellRef];
      } else {
        const cell = ws[cellRef];
        if (isHeader) {
          ws[cellRef] = { t: "s", v: String(cell.v || "") };
        } else if (cell.v === null || cell.v === undefined || String(cell.v).trim() === "") {
          delete ws[cellRef];
        } else if (typeof cell.v === "number") {
          ws[cellRef] = { t: "n", v: cell.v };
        } else {
          const text = String(cell.v);
          ws[cellRef] = { t: "s", v: text };
        }
      }
    }
  }

  ws["!cols"] = REPORT_STATUS_COLUMNS.map((header, ci) => {
    let width = header.length;
    for (let r = 1; r < aoa.length; r++) {
      const v = aoa[r][ci];
      const text = v === undefined || v === null ? "" : String(v);
      const longestLine = text.split("\n").reduce((max, line) => Math.max(max, line.length), 0);
      if (longestLine > width) width = longestLine;
    }
    return { wch: Math.max(12, Math.min(width + 3, 80)) };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Report Status");
  XLSX.writeFile(wb, "Report_Status.xlsx");
}

function addWaitingBlasting() {
  const selectedShift = document.getElementById("reportShift")?.value || "";
  
  if (selectedShift === "Shift 2") {
    alert("Waiting blasting hanya pada shift 1");
    return;
  }
  
  // Get unique locations from already rendered report status data
  const locations = [...new Set(
    reportStatusData
      .map(row => row.Location || "")
      .filter(loc => loc && loc.trim() !== "")
  )].sort();
  
  // Create or update modal
  let modal = document.getElementById("waitingBlastingModal");
  if (!modal) {
    modal = document.createElement("div");
    modal.id = "waitingBlastingModal";
    modal.className = "modal-overlay";
    modal.style.display = "flex";
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 400px;">
        <div class="modal-header">
          <h2>Filter Location - Waiting Blasting</h2>
          <button class="modal-close" onclick="closeWaitingBlastingModal()">✕</button>
        </div>
        <div class="edit-form">
          <div class="form-group">
            <label style="margin-bottom: 12px; display: block;">Select Location(s) Affected</label>
            <div id="locationFilterContainer" style="max-height: 300px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px;"></div>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn-cancel" onclick="closeWaitingBlastingModal()">Cancel</button>
          <button class="btn-save" onclick="confirmWaitingBlasting()" style="background: linear-gradient(135deg, #fde047, #f59e0b);">Apply</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
  }
  
  // Populate location checkboxes
  const container = document.getElementById("locationFilterContainer");
  if (container) {
    container.innerHTML = locations.map(loc => `
      <label style="display: block; padding: 8px; cursor: pointer;">
        <input type="checkbox" class="waiting-location-checkbox" value="${loc}" style="margin-right: 8px; accent-color: #f59e0b;" />
        ${loc}
      </label>
    `).join("");
  }
  
  modal.style.display = "flex";
}

function closeWaitingBlastingModal() {
  const modal = document.getElementById("waitingBlastingModal");
  if (modal) modal.style.display = "none";
}

function confirmWaitingBlasting() {
  const checkboxes = document.querySelectorAll(".waiting-location-checkbox:checked");
  waitingBlastingLocations = Array.from(checkboxes).map(cb => cb.value);
  
  if (waitingBlastingLocations.length === 0) {
    alert("Pilih minimal satu location");
    return;
  }
  
  waitingBlastingMode = true;
  closeWaitingBlastingModal();
  
  // Add waiting blasting rows to existing data instead of regenerating
  addWaitingBlastingToExistingData();
  
  alert(`Waiting Blasting berhasil ditambahkan untuk ${waitingBlastingLocations.length} location`);
}

function addWaitingBlastingToExistingData() {
  const selectedShift = document.getElementById("reportShift")?.value || "";
  
  if (selectedShift !== "Shift 1" || !waitingBlastingMode) return;
  
  processReportStatus();
  waitingBlastingMode = false;
}

window.addWaitingBlasting = addWaitingBlasting;
window.exportReportStatusExcel = exportReportStatusExcel;
window.closeWaitingBlastingModal = closeWaitingBlastingModal;
window.confirmWaitingBlasting = confirmWaitingBlasting;
