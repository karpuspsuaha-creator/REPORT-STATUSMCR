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
    { start: "06:00", end: "06:30", type: "Change Shift" },
    { start: "06:30", end: "12:00", type: "Activity" },
    { start: "12:00", end: "13:00", type: "Meal and Rest" },
    { start: "13:00", end: "17:30", type: "Activity" },
    { start: "17:30", end: "18:00", type: "Change Shift" },
  ],

  "Shift 2": [
    { start: "18:00", end: "18:30", type: "Change Shift" },
    { start: "18:30", end: "00:00", type: "Activity" },
    { start: "00:00", end: "01:00", type: "Meal and Rest" },
    { start: "01:00", end: "05:30", type: "Activity" },
    { start: "05:30", end: "06:00", type: "Change Shift" },
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
  return ["Activity", "Meal and Rest", "Change Shift"].includes(
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
      start: { start: "18:30", end: "00:00" },
      end: { start: "01:00", end: "05:30" },
    };
  }

  return {
    start: { start: "06:30", end: "12:00" },
    end: { start: "13:00", end: "17:30" },
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
          kml.category === "Working" && kmlItemCategory;

        newRow["Item Category"] = normalizeItemCategoryDisplay(
          useKmlItemCategory
            ? kmlItemCategory
            : dynamic["Item Category"] ||
                mapKmlItemCategory(kml.category) ||
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
  const overrides = [...(kmlOverrides || []), ...(sourceOverrides || [])];

  const merged = overrides.length
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

  return capTimelineActivitySlots(merged);
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

function getCutOffReportLabel(selectedShift) {
  if (selectedShift === "Shift 2") return "End of Shift 2";
  return "End of Shift 1";
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
    isStandbyTriggerItemCategory(itemCategory)
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

function processReportStatus() {
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

      if (kmlMeta.category === "Working" && t.type === "Activity") {
        const slotStartMin = toMinutes(t.start || "");
        const slotEndMin = toMinutes(t.end || "");

        // Tentukan apakah slot ini di waktu start atau end berdasarkan shift
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

        const chosenItemCategory = useStartItemCategory
          ? kmlMeta.startItemCategory
          : kmlMeta.endItemCategory;

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

        "Cut Off Report": getCutOffReportLabel(selectedShift),

        // 🔥 SOURCE TRACKING
        __source: t.source || "",
      };
    });
  });

  reportStatusData = ensureMinimumRows(finalRows);

  reportStatusData.sort(sortCodeUnit);

  renderReportStatusTable(reportStatusData);

  const btn = document.getElementById("exportReportStatusBtn");
  if (btn) btn.style.display = "flex";
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
  const container = document.getElementById("reportStatusResult");
  const info = document.getElementById("reportStatusInfo");

  if (!container) return;

  // =========================
  // EMPTY
  // =========================
  if (!data.length) {
    container.innerHTML = `
      <div class="empty-state">
        Tidak ada data
      </div>
    `;

    if (info) info.innerHTML = "";

    const pagination = document.getElementById("reportStatusPagination");

    if (pagination) {
      pagination.innerHTML = "";
    }

    return;
  }

  // =========================
  // INFO
  // =========================
  if (info) {
    info.innerHTML = `
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
  REPORT_STATUS_COLUMNS.forEach((h) => {
    html += `
      <th>${h}</th>
    `;
  });

  html += `
        </tr>
      </thead>

      <tbody>
  `;

  // =========================
  // ROWS
  // =========================
  data.forEach((row) => {
    const isKomdis = row.__source === "KOMDIS";

    html += `
    <tr>
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
    </tr>
  `;
  });

  // =========================
  // TABLE END
  // =========================
  html += `
      </tbody>
    </table>
  `;

  container.innerHTML = html;

  // =========================
  // DISABLE PAGINATION
  // =========================
  const pagination = document.getElementById("reportStatusPagination");

  if (pagination) {
    pagination.innerHTML = "";
  }
}

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

    if (!eqStartFile) missing.push("🗺️ Equipment Coordinate Start");
    if (!eqEndFile) missing.push("🗺️ Equipment Coordinate End");
    if (!areaFile) missing.push("🗺️ Boundary");
    if (!master.length) missing.push("🚜 Master Unit");

    if (missing.length) {
      alert(`Upload:\n\n${missing.join("\n")}`);
      return;
    }

    window.kmlResultStart = await processKMLKMZ(
      eqStartFile,
      areaFile,
      master,
      activity,
      "start",
    );
    window.kmlResultEnd = await processKMLKMZ(
      eqEndFile,
      areaFile,
      master,
      activity,
      "end",
    );
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
// EXPORT
// =========================

document
  .getElementById("exportReportStatusBtn")
  ?.addEventListener("click", () => {
    if (!reportStatusData.length) {
      alert("Tidak ada data");
      return;
    }

    const ws = XLSX.utils.json_to_sheet(reportStatusData);

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

    // Format kolom Before dan After sebagai time
    const beforeColIndex = REPORT_STATUS_COLUMNS.indexOf("Before");
    const afterColIndex = REPORT_STATUS_COLUMNS.indexOf("After");

    for (let R = range.s.r + 1; R <= range.e.r; ++R) {
      // Skip header row
      if (beforeColIndex >= 0) {
        const beforeCellRef = XLSX.utils.encode_cell({
          r: R,
          c: beforeColIndex,
        });
        if (ws[beforeCellRef] && ws[beforeCellRef].v) {
          const timeStr = String(ws[beforeCellRef].v);
          const [h, m] = timeStr.split(":").map(Number);
          if (!isNaN(h) && !isNaN(m)) {
            // Konversi ke Excel time serial (fraction of day)
            const timeValue = (h * 60 + m) / (24 * 60);
            ws[beforeCellRef] = { t: "n", v: timeValue, z: "hh:mm" };
          }
        }
      }
      if (afterColIndex >= 0) {
        const afterCellRef = XLSX.utils.encode_cell({ r: R, c: afterColIndex });
        if (ws[afterCellRef] && ws[afterCellRef].v) {
          const timeStr = String(ws[afterCellRef].v);
          const [h, m] = timeStr.split(":").map(Number);
          if (!isNaN(h) && !isNaN(m)) {
            // Konversi ke Excel time serial (fraction of day)
            const timeValue = (h * 60 + m) / (24 * 60);
            ws[afterCellRef] = { t: "n", v: timeValue, z: "hh:mm" };
          }
        }
      }
    }

    // =========================
    // AUTOFIT SMART
    // =========================

    ws["!cols"] = REPORT_STATUS_COLUMNS.map((header) => {
      let width = header.length;

      for (let i = 0; i < reportStatusData.length; i++) {
        const value = String(reportStatusData[i][header] ?? "");

        // handle text multiline
        const longestLine = value
          .split("\n")
          .reduce((max, line) => Math.max(max, line.length), 0);

        if (longestLine > width) {
          width = longestLine;
        }
      }

      return {
        wch: Math.max(
          12, // minimum
          Math.min(
            width + 3, // padding
            80, // maksimum
          ),
        ),
      };
    });

    const wb = XLSX.utils.book_new();

    XLSX.utils.book_append_sheet(wb, ws, "Report Status");

    XLSX.writeFile(wb, "Report_Status.xlsx");
  });

window.handleReportStatus = handleReportStatus;
