// =========================
// STATE GLOBAL
// =========================
let activeSection = "generateSection";

const status = {
  komdis: "Not Uploaded",
  foreman: "Not Uploaded",
  equipmentCoordinateStart: "Not Uploaded",
  equipmentCoordinateEnd: "Not Uploaded",
  boundaryKML: "Not Uploaded",
  masterUnit: "Not Uploaded",
  system: "Idle",
};

window.uploadedData = {};

function restorePersistedState() {
  try {
    const raw = localStorage.getItem("mcc_data");
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    window.uploadedData = parsed;

    if (Array.isArray(parsed.foreman)) {
      window.foremanData = parsed.foreman;
    }

    if (Array.isArray(parsed.komdis)) {
      window.komdisData = parsed.komdis;
    }
  } catch (err) {
    console.warn("Gagal restore state", err);
  }
}

function persistAppState() {
  try {
    localStorage.setItem("mcc_data", JSON.stringify(window.uploadedData));
  } catch (err) {
    console.warn("Gagal simpan state", err);
  }
}

window.restorePersistedState = restorePersistedState;
window.persistAppState = persistAppState;

restorePersistedState();

// =========================
// INIT
// =========================
document.addEventListener("DOMContentLoaded", () => {
  restorePersistedState();

  const defaultSection = document.getElementById(activeSection);
  const defaultMenu = document.querySelector(
    `[data-target="${activeSection}"]`,
  );

  if (defaultSection) defaultSection.classList.add("active-section");
  if (defaultMenu) defaultMenu.classList.add("active");

  updateStatusUI();
});

// =========================
// MENU SWITCH
// =========================
const menuItems = document.querySelectorAll(".menu-item");
const sections = document.querySelectorAll(".page-section");
const pageTitle = document.getElementById("pageTitle");

menuItems.forEach((item) => {
  item.onclick = () => {
    menuItems.forEach((m) => m.classList.remove("active"));
    sections.forEach((s) => s.classList.remove("active-section"));

    item.classList.add("active");

    const target = document.getElementById(item.dataset.target);

    if (target) {
      target.classList.add("active-section");
      activeSection = item.dataset.target;
    }

    if (pageTitle) {
      pageTitle.textContent = item.textContent.trim();
    }
  };
});

// =========================
// STATUS UI
// =========================
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function updateStatusUI() {
  setText("statusKomdis", status.komdis);
  setText("statusForeman", status.foreman);
  setText("statusEquipmentCoordinateStart", status.equipmentCoordinateStart);
  setText("statusEquipmentCoordinateEnd", status.equipmentCoordinateEnd);
  setText("statusBoundaryKML", status.boundaryKML);
  setText("statusMasterUnit", status.masterUnit);
  setText("statusSystem", status.system);
}

// =========================
// VALIDASI FILE (GLOBAL)
// =========================
const filePipeline = {
  komdis: {
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

      sheets.forEach(({ sheet, data }) => {
        console.log("PROCESS KOMDIS:", sheet);

        result.push(...processKomdis(data));
      });

      console.log("KOMDIS TOTAL:", result.length);

      return result;
    },
  },

  foreman: {
    validate: (file) =>
      [".xlsx", ".xlsm", ".xlsb"].some((ext) =>
        file.name.toLowerCase().endsWith(ext),
      ),

    process: async (file) => {
      const workbook = XLSX.read(await file.arrayBuffer(), {
        type: "array",
      });

      const sheets = extractForemanSheet(workbook);

      let result = [];

      sheets.forEach(({ sheet, data }) => {
        console.log("PROCESS FOREMAN:", sheet);

        result.push(...processForeman(data));
      });

      return result;
    },
  },

  masterUnit: {
    validate: (file) =>
      [".xlsx", ".xlsm", ".xlsb"].some((ext) =>
        file.name.toLowerCase().endsWith(ext),
      ),

    process: async (file) => {
      const workbook = XLSX.read(await file.arrayBuffer(), {
        type: "array",
      });

      const sheets = extractMasterUnitSheet(workbook);

      const result = {
        master: [],
        masterUnit: [],
        activity: [],
      };

      sheets.forEach(({ sheet, data }) => {
        console.log("PROCESS:", sheet);

        const parsed = processMasterUnit(data, sheet);

        if (sheet.toUpperCase().includes("#MASTER")) {
          result.master.push(...parsed);

          console.log("MASTER:", result.master.length);
        }

        if (sheet.toUpperCase().includes("$MASTER UNIT")) {
          result.masterUnit.push(...parsed);

          console.log("MASTER UNIT:", result.masterUnit.length);
        }
      });

      // Process ACTIVITY sheet
      const activitySheets = extractActivitySheet(workbook);
      activitySheets.forEach(({ sheet, data }) => {
        console.log("PROCESS ACTIVITY:", sheet);

        const parsed = processActivitySheet(data, sheet);
        result.activity.push(...parsed);

        console.log("ACTIVITY:", result.activity.length);
      });

      return result;
    },
  },

  equipmentCoordinateStart: {
    validate: (file) =>
      [".kml", ".kmz"].some((ext) => file.name.toLowerCase().endsWith(ext)),
    process: async (file) => readKML(file),
  },

  equipmentCoordinateEnd: {
    validate: (file) =>
      [".kml", ".kmz"].some((ext) => file.name.toLowerCase().endsWith(ext)),
    process: async (file) => readKML(file),
  },

  boundaryKML: {
    validate: (file) =>
      [".kml", ".kmz"].some((ext) => file.name.toLowerCase().endsWith(ext)),
    process: async (file) => readKML(file),
  },
};

// =========================
// READ EXCEL
// =========================
function readExcel(file) {
  return new Promise((resolve, reject) => {
    if (!window.XLSX) return reject("XLSX not loaded");

    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);

        const wb = XLSX.read(data, {
          type: "array",
        });

        const sheet = wb.Sheets[wb.SheetNames[0]];

        const json = XLSX.utils.sheet_to_json(sheet, {
          header: 1,
          defval: "",
        });

        resolve(json);
      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// =========================
// HANDLE FILE
// =========================
async function handleFile(type) {
  const input = document.getElementById(type + "File");
  if (!input || !input.files.length) return;

  const file = input.files[0];

  console.log("FILE:", type, file.name);

  try {
    status[type] = "Processing ⏳";
    status.system = "Processing ⏳";
    updateStatusUI();

    let data;

    const pipeline = filePipeline[type];

    if (!pipeline) {
      throw new Error("No pipeline found for type: " + type);
    }

    if (!pipeline.validate(file)) {
      alert("File tidak sesuai format yang diizinkan");
      return;
    }

    data = await pipeline.process(file);

    if (type === "foreman") {
      window.foremanData = data;
    }

    if (type === "komdis") {
      window.komdisData = data;
    }

    // =========================
    // SPLIT MASTER + MASTER UNIT + ACTIVITY
    // =========================
    if (type === "masterUnit" && data.master && data.masterUnit) {
      uploadedData.master = data.master;

      uploadedData.masterUnit = data.masterUnit;

      if (data.activity) {
        uploadedData.activity = data.activity;
      }
    } else {
      uploadedData[type] = data;
    }

    persistAppState();

    status[type] = "Uploaded ✔";
  } catch (err) {
    console.error(err);
    status[type] = "Failed ❌";
  }

  const allDone =
    status.komdis === "Uploaded ✔" &&
    status.foreman === "Uploaded ✔" &&
    status.equipmentCoordinateStart === "Uploaded ✔" &&
    status.equipmentCoordinateEnd === "Uploaded ✔" &&
    status.boundaryKML === "Uploaded ✔" &&
    status.masterUnit === "Uploaded ✔";

  status.system = allDone ? "Ready ✔" : "Waiting Files ⏳";

  updateStatusUI();

  console.log("STATUS:", status);
  console.log("DATA:", uploadedData);
}

// =========================
// READ KML + KMZ
// =========================
async function readKML(file) {
  const fileName = file.name.toLowerCase();

  if (fileName.endsWith(".kml")) {
    const text = await file.text();
    return new DOMParser().parseFromString(text, "text/xml");
  }

  if (fileName.endsWith(".kmz")) {
    if (!window.JSZip) throw new Error("JSZip belum di-load");

    const zip = await JSZip.loadAsync(file);

    let kmlText = "";

    for (const path in zip.files) {
      if (path.toLowerCase().endsWith(".kml")) {
        kmlText = await zip.files[path].async("text");
        break;
      }
    }

    return new DOMParser().parseFromString(kmlText, "text/xml");
  }

  throw new Error("Format tidak didukung");
}

// =========================
// EXPORT
// =========================
window.handleFile = handleFile;
