// === OFFLINE-BUILD HOOKS START ===
// In offline builds, build_local.py replaces this block with an inline DuckDB
// asset loader. Leave the markers intact. OFFLINE_DUCKDB_WORKER_URL must be
// declared here (not later) so the loader can assign it without a TDZ error.
let OFFLINE_DUCKDB_WORKER_URL = null;
const OFFLINE_DUCKDB_LOADER = null;
const OFFLINE_DUCKDB_WASM_NAME = null;
// === OFFLINE-BUILD HOOKS END ===

const duckdb = OFFLINE_DUCKDB_LOADER
  ? await OFFLINE_DUCKDB_LOADER()
  : await import("https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@latest/+esm");

// Parquet files (and, in offline builds, the DuckDB wasm) live next to
// index.html — single deploy directory. Override via ?data=… if needed.
const DATA = (() => {
  const param = new URLSearchParams(window.location.search).get("data");
  if (!param) return "./";
  return param.endsWith("/") ? param : param + "/";
})();

// Hungarian yearly average CPI change (KSH). Used to adjust historical
// HUF amounts to INFLATION_TARGET_YEAR forints.
const INFLATION_RATES = {
  2000: 9.8, 2001: 9.2, 2002: 5.3, 2003: 4.7, 2004: 6.8,
  2005: 3.6, 2006: 3.9, 2007: 8.0, 2008: 6.1, 2009: 4.2,
  2010: 4.9, 2011: 3.9, 2012: 5.7, 2013: 1.7, 2014: -0.2,
  2015: -0.1, 2016: 0.4, 2017: 2.4, 2018: 2.8, 2019: 3.4,
  2020: 3.3, 2021: 5.1, 2022: 14.5, 2023: 17.6, 2024: 3.7,
  2025: 4.5,
};
const INFLATION_TARGET_YEAR = 2025;

function buildInflationMultipliers() {
  const years = Object.keys(INFLATION_RATES).map(Number).sort((a, b) => a - b);
  const cpi = {};
  let level = 100;
  let first = true;
  for (const y of years) {
    if (first) {
      cpi[y] = level;
      first = false;
    } else {
      level = level * (1 + INFLATION_RATES[y] / 100);
      cpi[y] = level;
    }
  }
  const target = cpi[INFLATION_TARGET_YEAR];
  const mults = {};
  for (const y of years) mults[y] = target / cpi[y];
  return mults;
}

const INFLATION_MULTS = buildInflationMultipliers();

function inflationMacroSql() {
  const lines = Object.entries(INFLATION_MULTS)
    .map(([y, m]) => `      WHEN ${y} THEN ${m.toFixed(6)}`)
    .join("\n");
  return `
    CREATE OR REPLACE MACRO infl_mult(year) AS
      CASE year
${lines}
        ELSE 1.0
      END;
  `;
}

// Year extracted from the igénylés dátuma dim. The summary aggregates use
// the subquery form (no JOIN); the results query injects the dim_igenyles_datum
// join on-demand (only when sorting needs it) via SORT_JOINS.
const YEAR_EXPR_SUB =
  "CAST(substr((SELECT value FROM dim_igenyles_datum WHERE id = f.igenyles_datuma_id), 1, 4) AS INTEGER)";
const MULT_EXPR_SUB = `infl_mult(${YEAR_EXPR_SUB})`;
const IGENYELT_REAL_EXPR_SUB = `f.igenyelt_koltsegvetesi_tamogatas_osszege * ${MULT_EXPR_SUB}`;
const ODAITELT_REAL_EXPR_SUB = `f.odaitelt_teljes_tamogatasi_osszeg * ${MULT_EXPR_SUB}`;

const YEAR_EXPR_JOINED = "CAST(substr(d.value, 1, 4) AS INTEGER)";
const MULT_EXPR_JOINED = `infl_mult(${YEAR_EXPR_JOINED})`;
const IGENYELT_REAL_EXPR_JOINED = `f.igenyelt_koltsegvetesi_tamogatas_osszege * ${MULT_EXPR_JOINED}`;
const ODAITELT_REAL_EXPR_JOINED = `f.odaitelt_teljes_tamogatasi_osszeg * ${MULT_EXPR_JOINED}`;

// Each sort key maps to (a) the SQL expression used in ORDER BY and
// (b) the extra JOIN required to make that expression resolvable.
const SORT_COLUMNS = {
  igenylo:        { expr: "f.tamogatasi_igeny_benyujtojanak_megnevezese", join: "" },
  tipus:          { expr: "t.value",  join: "LEFT JOIN dim_tipus t ON f.tipus_id = t.id" },
  megye:          { expr: "m.value",  join: "LEFT JOIN dim_megye m ON f.szekhely_lakcim_megye_id = m.id" },
  palyazat:       { expr: "p.value",  join: "LEFT JOIN dim_palyazat p ON f.palyazat_id = p.id" },
  konstrukcio:    { expr: "k.value",  join: "LEFT JOIN dim_konstrukcio k ON f.tamogatasi_konstrukcio_id = k.id" },
  statusz:        { expr: "s.value",  join: "LEFT JOIN dim_statusz s ON f.igenyles_statusza_id = s.id" },
  lezaras:        { expr: "l.value",  join: "LEFT JOIN dim_lezaras l ON f.lezaras_oka_id = l.id" },
  // Date dims: ids are assigned in ORDER BY value order by build_date_dim, and
  // the date values are 'YYYY-MM-DD' (lexicographically chronological).
  // Sorting by the FK id is equivalent to sorting by the joined value but
  // avoids the JOIN and lets DuckDB top-N over the filter result directly.
  igenyles_datuma:{ expr: "f.igenyles_datuma_id", join: "" },
  dontes_datuma:  { expr: "f.tamogatasi_dontes_datuma_id", join: "" },
  kezdodatum:     { expr: "f.kezdodatum_id", join: "" },
  vegdatum:       { expr: "f.vegdatum_id", join: "" },
  igenyelt:       { expr: "f.igenyelt_koltsegvetesi_tamogatas_osszege", join: "" },
  odaitelt:       { expr: "f.odaitelt_teljes_tamogatasi_osszeg",        join: "" },
  igenyelt_real:  { expr: IGENYELT_REAL_EXPR_JOINED, join: "LEFT JOIN dim_igenyles_datum d ON f.igenyles_datuma_id = d.id" },
  odaitelt_real:  { expr: ODAITELT_REAL_EXPR_JOINED, join: "LEFT JOIN dim_igenyles_datum d ON f.igenyles_datuma_id = d.id" },
  szazalek:       { expr: "f.tamogatas_az_igenyles_szazalekaban", join: "" },
  azonosito:      { expr: "f.igenyles_azonositoja", join: "" },
  dontesre:       { expr: "dj.value", join: "LEFT JOIN dim_dontesre_jogosult dj ON f.dontesre_jogosult_szemely_vagy_testulet_id = dj.id" },
};

const DEFAULT_STATE = {
  search: "",
  megye: "",
  statusz: "",
  lezaras: "",
  palyazat: "",
  tipus: "",
  konstrukcio: "",
  dontesre: "",
  igenyloEq: "",
  celEq: "",
  dateFrom: "",
  dateTo: "",
  dontesDateFrom: "",
  dontesDateTo: "",
  igenyeltMin: "",
  igenyeltMax: "",
  amountMin: "",
  amountMax: "",
  sort: "odaitelt",
  dir: "desc",
  page: 1,
  pageSize: 100,
};

let db;
let conn;
let dimCache = {};
let currentState = { ...DEFAULT_STATE };
let queryToken = 0;
let restoringFromUrl = false;

const $ = (id) => document.getElementById(id);

function setStatus(text, kind = "info") {
  const el = $("status");

  if (!text) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("loading");
    return;
  }

  el.hidden = false;
  el.textContent = text;
  el.dataset.kind = kind;
  // Treat trailing ellipsis as an in-progress indicator.
  const isLoading = kind !== "error" && /[…\.]{1,3}\s*$/.test(text);
  el.classList.toggle("loading", isLoading);
}

function formatNumber(n) {
  if (n === null || n === undefined) return "–";
  return new Intl.NumberFormat("hu-HU").format(Number(n));
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "–";

  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

async function initDuckDB() {
  let bundle;
  if (OFFLINE_DUCKDB_WASM_NAME) {
    bundle = getOfflineDuckDBBundle();
  } else {
    const bundles = duckdb.getJsDelivrBundles();
    bundle = await duckdb.selectBundle(bundles);
  }

  // For CDN bundles, mainWorker is a cross-origin https URL — `new Worker()`
  // refuses that, so we wrap it in a same-origin blob that importScripts()
  // the real worker. For offline bundles mainWorker is already a blob URL
  // (same null-origin as the page), and Chrome blocks blob→blob
  // importScripts under file://, so we hand the worker URL to `new Worker()`
  // directly.
  const needsShim = !bundle.mainWorker.startsWith("blob:");
  const workerUrl = needsShim
    ? URL.createObjectURL(
        new Blob([`importScripts("${bundle.mainWorker}");`], {
          type: "text/javascript",
        })
      )
    : bundle.mainWorker;

  const worker = new Worker(workerUrl);

  // Offline build: hand the wasm bytes to the worker so its patched fetch()
  // can serve them without ever touching a blob: URL (which Chrome refuses
  // to fetch from a null-origin worker). Transfer the buffer for zero-copy.
  if (OFFLINE_DUCKDB_WASM_NAME && localDuckDBWasmBuffer) {
    const bytes = localDuckDBWasmBuffer;
    localDuckDBWasmBuffer = null;
    worker.postMessage({ __offline_wasm_bytes: bytes }, [bytes.buffer]);
  }

  const logger = new duckdb.ConsoleLogger();

  db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  if (needsShim) URL.revokeObjectURL(workerUrl);

  conn = await db.connect();

  // Keep DuckDB-WASM well below the 4 GB WASM heap ceiling. Single thread
  // avoids per-thread buffer duplication, and disabling insertion-order
  // preservation lets ORDER BY … LIMIT use Top-N pruning.
  await conn.query(`
    SET threads=1;
    SET memory_limit='1200MB';
    SET preserve_insertion_order=false;
  `);
}

// The fact table is split across many small Parquet files so individual
// files stay under GitHub's 25 MB web-upload limit. The manifest, written
// by export_to_parquet.py, lists the chunks in row-order; the browser
// unions them via `read_parquet([...])`.
const FACT_MANIFEST_FILE = "tamogatasok_web.manifest.json";

const DIM_PARQUET_FILES = [
  "dim_dontesre_jogosult_szemely_vagy_testulet.parquet",
  "dim_igenyles_datuma.parquet",
  "dim_igenyles_statusza.parquet",
  "dim_kezdodatum.parquet",
  "dim_lezaras_oka.parquet",
  "dim_palyazat.parquet",
  "dim_szekhely_lakcim_megye.parquet",
  "dim_tamogatasi_dontes_datuma.parquet",
  "dim_tamogatasi_konstrukcio.parquet",
  "dim_tipus.parquet",
  "dim_vegdatum.parquet",
];

// Populated from the manifest at startup (HTTP: fetched; offline: read from
// the picked folder). Both code paths must run their loader before any code
// that touches `factChunkFiles` or calls `allParquetFiles()`.
let factChunkFiles = [];

function parseFactManifest(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Hibás ${FACT_MANIFEST_FILE}: ${err.message ?? err}`);
  }
  if (!data || !Array.isArray(data.files) || data.files.length === 0) {
    throw new Error(`Üres vagy hibás ${FACT_MANIFEST_FILE}.`);
  }
  return data.files;
}

function allParquetFiles() {
  return [...factChunkFiles, ...DIM_PARQUET_FILES];
}

const IS_FILE_PROTOCOL = window.location.protocol === "file:";

// Extra files the offline build needs to be picked alongside the parquets.
const OFFLINE_EXTRA_FILES = OFFLINE_DUCKDB_WASM_NAME ? [OFFLINE_DUCKDB_WASM_NAME] : [];

// User-picked WASM bytes; held briefly between picker and initDuckDB.
let localDuckDBWasmBuffer = null;

function getOfflineDuckDBBundle() {
  if (!localDuckDBWasmBuffer) {
    throw new Error(`Hiányzik a ${OFFLINE_DUCKDB_WASM_NAME} fájl.`);
  }
  // Blob URL exists only so DuckDB's worker has a string to "fetch" —
  // the worker's fetch is patched (by the offline build's worker preamble)
  // to return the preloaded wasm bytes for any blob: URL, sidestepping
  // Chrome's refusal to fetch blob: URLs from a blob:null worker.
  const wasmUrl = URL.createObjectURL(
    new Blob([localDuckDBWasmBuffer], { type: "application/wasm" })
  );
  return {
    mainModule: wasmUrl,
    mainWorker: OFFLINE_DUCKDB_WORKER_URL,
    pthreadWorker: null,
  };
}

async function loadFactManifestHttp() {
  const url = new URL(DATA + FACT_MANIFEST_FILE, window.location.href).toString();
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `Hiányzó manifest fájl: ${FACT_MANIFEST_FILE} (HTTP ${resp.status})`
    );
  }
  factChunkFiles = parseFactManifest(await resp.text());
}

async function registerParquetFilesHttp() {
  await loadFactManifestHttp();
  const dataBaseUrl = new URL(DATA, window.location.href).toString();

  for (const file of allParquetFiles()) {
    await db.registerFileURL(
      file,
      `${dataBaseUrl}${file}`,
      duckdb.DuckDBDataProtocol.HTTP,
      false
    );
  }
}

async function readFileAsBuffer(file) {
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

async function pickFilesViaDirectoryHandle() {
  if (typeof window.showDirectoryPicker !== "function") return null;

  let dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ id: "ak-csv-data", mode: "read" });
  } catch (err) {
    if (err && err.name === "AbortError") return null;
    throw err;
  }

  // The manifest tells us which fact chunks to require. Read it first so
  // missing chunks show up in the same "missing files" error as the dims.
  let manifestFile;
  try {
    manifestFile = await (await dirHandle.getFileHandle(FACT_MANIFEST_FILE)).getFile();
  } catch {
    throw new Error(`A kiválasztott mappából hiányzó fájl: ${FACT_MANIFEST_FILE}`);
  }
  factChunkFiles = parseFactManifest(await manifestFile.text());

  const required = [
    FACT_MANIFEST_FILE,
    ...factChunkFiles,
    ...DIM_PARQUET_FILES,
    ...OFFLINE_EXTRA_FILES,
  ];

  const collected = { [FACT_MANIFEST_FILE]: manifestFile };
  const missing = [];

  for (const name of required) {
    if (collected[name]) continue;
    try {
      const handle = await dirHandle.getFileHandle(name);
      collected[name] = await handle.getFile();
    } catch {
      missing.push(name);
    }
  }

  if (missing.length) {
    throw new Error(
      `A kiválasztott mappából hiányzó fájl(ok): ${missing.join(", ")}`
    );
  }

  return collected;
}

function pickFilesViaInput() {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    // webkitdirectory lets users pick a folder. We DO NOT set `accept`
    // alongside it because some browsers then filter the directory listing
    // down to nothing visible. Folder picker shows in Chromium and Firefox;
    // Safari falls back to a multi-file picker.
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    // Hidden but in the DOM — some browsers ignore .click() on detached inputs.
    input.style.position = "fixed";
    input.style.left = "-10000px";
    document.body.appendChild(input);

    const cleanup = () => {
      if (input.parentNode) input.parentNode.removeChild(input);
    };

    input.addEventListener(
      "change",
      async () => {
        const filesByName = {};
        for (const file of input.files) {
          filesByName[file.name] = file;
        }
        cleanup();

        const manifestFile = filesByName[FACT_MANIFEST_FILE];
        if (!manifestFile) {
          reject(
            new Error(
              `A kiválasztott mappából hiányzó fájl: ${FACT_MANIFEST_FILE}`
            )
          );
          return;
        }

        try {
          factChunkFiles = parseFactManifest(await manifestFile.text());
        } catch (err) {
          reject(err);
          return;
        }

        const required = [
          FACT_MANIFEST_FILE,
          ...factChunkFiles,
          ...DIM_PARQUET_FILES,
          ...OFFLINE_EXTRA_FILES,
        ];

        const missing = required.filter((name) => !filesByName[name]);
        if (missing.length) {
          reject(
            new Error(
              `A kiválasztott mappából hiányzó fájl(ok): ${missing.join(", ")}`
            )
          );
          return;
        }

        const collected = {};
        for (const name of required) {
          collected[name] = filesByName[name];
        }
        resolve(collected);
      },
      { once: true }
    );

    input.addEventListener(
      "cancel",
      () => {
        cleanup();
        resolve(null);
      },
      { once: true }
    );

    input.click();
  });
}

// In file:// mode we collect the user's chosen files up-front, then register
// them as DuckDB file buffers later (after DuckDB is initialised).
let localBuffers = null;

function waitForLocalFiles() {
  const overlay = $("localLoader");
  const button = $("localLoaderButton");
  const message = $("localLoaderMessage");

  overlay.hidden = false;
  message.textContent = "";
  button.disabled = false;

  return new Promise((resolve, reject) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      message.textContent = "Mappa kiválasztása…";

      let collected;
      try {
        // We must call the picker synchronously inside the click handler to
        // keep the user-activation token alive, so try the (sync-returning)
        // input fallback first when the modern API isn't available.
        if (typeof window.showDirectoryPicker === "function") {
          collected = await pickFilesViaDirectoryHandle();
        } else {
          collected = await pickFilesViaInput();
        }
      } catch (err) {
        message.textContent = `Hiba: ${err.message ?? err}`;
        button.disabled = false;
        return;
      }

      if (!collected) {
        message.textContent = "Kiválasztás megszakítva.";
        button.disabled = false;
        return;
      }

      try {
        const buffers = {};
        const parquets = allParquetFiles();
        const totalCount = parquets.length + OFFLINE_EXTRA_FILES.length;
        let loaded = 0;
        for (const name of parquets) {
          message.textContent = `Beolvasás: ${name} (${++loaded}/${totalCount})`;
          buffers[name] = await readFileAsBuffer(collected[name]);
        }
        for (const name of OFFLINE_EXTRA_FILES) {
          message.textContent = `Beolvasás: ${name} (${++loaded}/${totalCount})`;
          // Extras (currently just the DuckDB WASM) go to a dedicated slot
          // so they aren't registered as parquet file buffers.
          if (name === OFFLINE_DUCKDB_WASM_NAME) {
            localDuckDBWasmBuffer = await readFileAsBuffer(collected[name]);
          }
        }
        overlay.hidden = true;
        resolve(buffers);
      } catch (err) {
        message.textContent = `Hiba: ${err.message ?? err}`;
        button.disabled = false;
        reject(err);
      }
    });
  });
}

async function registerParquetFilesLocal() {
  if (!localBuffers) {
    throw new Error("A helyi parquet fájlokat nem választotta ki a felhasználó.");
  }
  for (const name of allParquetFiles()) {
    await db.registerFileBuffer(name, localBuffers[name]);
  }
  localBuffers = null; // free reference after DuckDB has copied the bytes
}

async function registerParquetFiles() {
  if (IS_FILE_PROTOCOL) {
    await registerParquetFilesLocal();
  } else {
    await registerParquetFilesHttp();
  }
}

async function query(sql) {
  if (window.__BENCH) {
    const label = (sql.match(/^\s*\w+/)?.[0] || "query").toLowerCase();
    const t0 = performance.now();
    const result = await conn.query(sql);
    const tQuery = performance.now() - t0;
    const rows = result.toArray().map((row) => row.toJSON());
    const tTotal = performance.now() - t0;
    console.log(
      `[bench] ${label}: ${tQuery.toFixed(1)}ms query + ${(tTotal - tQuery).toFixed(1)}ms decode, ${rows.length} rows`
    );
    if (window.__BENCH === "verbose") console.log(sql.trim());
    return rows;
  }
  const result = await conn.query(sql);
  return result.toArray().map((row) => row.toJSON());
}

// --- Search benchmarking helpers (exposed on window) ----------------------
// Usage from devtools:
//   __BENCH = true              -> log every query timing
//   benchSearch("máltai", 5)    -> run results+summary queries N times, report avg/min/max
//   explainSearch("máltai")     -> EXPLAIN ANALYZE the results query
async function benchSearch(term, runs = 3) {
  if (!conn) { console.warn("DuckDB not ready"); return; }
  const state = { ...currentState, search: term, page: 1 };
  const where = buildWhere(state);
  const orderBy = buildOrderBy(state);
  const sortJoin = buildSortJoin(state);
  const limit = Number(state.pageSize);
  const resultsSql = `
    SELECT f.id, f.tamogatasi_igeny_benyujtojanak_megnevezese AS igenylo,
           f.tamogatasi_igeny_celja AS cel,
           f.igenyelt_koltsegvetesi_tamogatas_osszege AS igenyelt,
           f.odaitelt_teljes_tamogatasi_osszeg AS odaitelt
    FROM fact f ${sortJoin} ${where} ${orderBy} LIMIT ${limit}
  `;
  const summarySql = `
    SELECT f.igenyles_datuma_id AS dt_id, COUNT(*) AS cnt,
           SUM(f.igenyelt_koltsegvetesi_tamogatas_osszege) AS s_igenyelt,
           SUM(f.odaitelt_teljes_tamogatasi_osszeg) AS s_odaitelt,
           MIN(f.tamogatasi_dontes_datuma_id) AS min_dontes_id,
           MAX(f.tamogatasi_dontes_datuma_id) AS max_dontes_id
    FROM fact f ${where} GROUP BY f.igenyles_datuma_id
  `;
  console.log(`[bench] search=${JSON.stringify(term)} runs=${runs}`);
  console.log(`[bench] WHERE: ${where || "(none)"}`);
  for (const [name, sql] of [["results", resultsSql], ["summary", summarySql]]) {
    const times = [];
    let rowCount = 0;
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const r = await conn.query(sql);
      rowCount = r.numRows;
      times.push(performance.now() - t0);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    console.log(
      `[bench] ${name}: rows=${rowCount}  avg=${avg.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms  (${times.map(t => t.toFixed(0)).join(", ")})`
    );
  }
}

async function explainSearch(term) {
  if (!conn) { console.warn("DuckDB not ready"); return; }
  const state = { ...currentState, search: term, page: 1 };
  const where = buildWhere(state);
  const sortJoin = buildSortJoin(state);
  const orderBy = buildOrderBy(state);
  const sql = `EXPLAIN ANALYZE
    SELECT f.id FROM fact f ${sortJoin} ${where} ${orderBy}
    LIMIT ${Number(state.pageSize)}`;
  const r = await conn.query(sql);
  for (const row of r.toArray().map((x) => x.toJSON())) {
    console.log(Object.values(row).join("\n"));
  }
}

window.benchSearch = benchSearch;
window.explainSearch = explainSearch;
// Generic escape hatch for ad-hoc devtools queries.
window.runSql = async (sql) => {
  const r = await conn.query(sql);
  return r.toArray().map((row) => row.toJSON());
};

async function createViews() {
  await registerParquetFiles();

  // factChunkFiles is populated by registerParquetFiles() (HTTP fetches the
  // manifest; offline reads it from the picked folder). DuckDB unions the
  // listed files as if they were one table, preserving row order because
  // the export script wrote them single-threaded with ORDER BY id.
  const factFilesSql = factChunkFiles.map((f) => `'${f}'`).join(", ");

  await conn.query(`
    CREATE VIEW fact AS SELECT * FROM read_parquet([${factFilesSql}]);
    CREATE VIEW dim_megye AS SELECT * FROM read_parquet('dim_szekhely_lakcim_megye.parquet');
    CREATE VIEW dim_statusz AS SELECT * FROM read_parquet('dim_igenyles_statusza.parquet');
    CREATE VIEW dim_lezaras AS SELECT * FROM read_parquet('dim_lezaras_oka.parquet');
    CREATE VIEW dim_palyazat AS SELECT * FROM read_parquet('dim_palyazat.parquet');
    CREATE VIEW dim_tipus AS SELECT * FROM read_parquet('dim_tipus.parquet');
    CREATE VIEW dim_konstrukcio AS SELECT * FROM read_parquet('dim_tamogatasi_konstrukcio.parquet');
    CREATE VIEW dim_dontesre_jogosult AS SELECT * FROM read_parquet('dim_dontesre_jogosult_szemely_vagy_testulet.parquet');
    CREATE VIEW dim_igenyles_datum AS SELECT * FROM read_parquet('dim_igenyles_datuma.parquet');
    CREATE VIEW dim_kezdodatum AS SELECT * FROM read_parquet('dim_kezdodatum.parquet');
    CREATE VIEW dim_vegdatum AS SELECT * FROM read_parquet('dim_vegdatum.parquet');
    CREATE VIEW dim_dontes_datum AS SELECT * FROM read_parquet('dim_tamogatasi_dontes_datuma.parquet');
  `);

  await conn.query(inflationMacroSql());
}

async function loadDimensions() {
  const dimViews = {
    megye: "dim_megye",
    statusz: "dim_statusz",
    lezaras: "dim_lezaras",
    palyazat: "dim_palyazat",
    tipus: "dim_tipus",
    konstrukcio: "dim_konstrukcio",
    dontesre: "dim_dontesre_jogosult",
    igenyles_datum: "dim_igenyles_datum",
    dontes_datum: "dim_dontes_datum",
    kezdodatum: "dim_kezdodatum",
    vegdatum: "dim_vegdatum",
  };

  const entries = await Promise.all(
    Object.entries(dimViews).map(async ([key, view]) => {
      const rows = await query(
        `SELECT id, value FROM ${view} WHERE value IS NOT NULL`
      );
      const map = new Map();
      const list = [];
      for (const row of rows) {
        const id = Number(row.id);
        const value = row.value;
        map.set(id, value);
        list.push({ id, value });
      }
      list.sort((a, b) =>
        a.value < b.value ? -1 : a.value > b.value ? 1 : 0
      );
      return [key, { list, map }];
    })
  );

  dimCache = Object.fromEntries(entries);
}

function fillSelect(selectId, dim) {
  const select = $(selectId);
  const fragment = document.createDocumentFragment();

  for (const row of dim.list) {
    const option = document.createElement("option");
    option.value = row.id;
    option.textContent = row.value;
    fragment.appendChild(option);
  }

  select.appendChild(fragment);
}

function fillDatalist(listId, dim) {
  const list = $(listId);
  const fragment = document.createDocumentFragment();

  for (const row of dim.list) {
    const option = document.createElement("option");
    option.value = row.value;
    option.dataset.id = String(row.id);
    fragment.appendChild(option);
  }

  list.appendChild(fragment);
}

function populateFilters() {
  fillSelect("megye", dimCache.megye);
  fillSelect("statusz", dimCache.statusz);
  fillSelect("lezaras", dimCache.lezaras);
  fillSelect("palyazat", dimCache.palyazat);
  fillSelect("tipus", dimCache.tipus);
  fillDatalist("konstrukcioList", dimCache.konstrukcio);
  fillDatalist("dontesreList", dimCache.dontesre);
}

function lookupDatalistId(dim, value) {
  if (!value) return null;
  const match = dim.list.find((row) => row.value === value);
  return match ? match.id : null;
}

function buildWhere(state) {
  const clauses = [];

  if (state.megye) clauses.push(`f.szekhely_lakcim_megye_id = ${Number(state.megye)}`);
  if (state.statusz) clauses.push(`f.igenyles_statusza_id = ${Number(state.statusz)}`);
  if (state.lezaras) clauses.push(`f.lezaras_oka_id = ${Number(state.lezaras)}`);
  if (state.palyazat) clauses.push(`f.palyazat_id = ${Number(state.palyazat)}`);
  if (state.tipus) clauses.push(`f.tipus_id = ${Number(state.tipus)}`);

  const konstrukcioId = lookupDatalistId(dimCache.konstrukcio, state.konstrukcio);
  if (konstrukcioId !== null) {
    clauses.push(`f.tamogatasi_konstrukcio_id = ${Number(konstrukcioId)}`);
  }

  const dontesreId = lookupDatalistId(dimCache.dontesre, state.dontesre);
  if (dontesreId !== null) {
    clauses.push(`f.dontesre_jogosult_szemely_vagy_testulet_id = ${Number(dontesreId)}`);
  }

  if (state.dateFrom) {
    clauses.push(`
      f.igenyles_datuma_id IN (
        SELECT id FROM dim_igenyles_datum
        WHERE value >= ${sqlString(state.dateFrom)}
      )
    `);
  }

  if (state.dateTo) {
    clauses.push(`
      f.igenyles_datuma_id IN (
        SELECT id FROM dim_igenyles_datum
        WHERE value <= ${sqlString(state.dateTo)}
      )
    `);
  }

  if (state.dontesDateFrom) {
    clauses.push(`
      f.tamogatasi_dontes_datuma_id IN (
        SELECT id FROM dim_dontes_datum
        WHERE value >= ${sqlString(state.dontesDateFrom)}
      )
    `);
  }

  if (state.dontesDateTo) {
    clauses.push(`
      f.tamogatasi_dontes_datuma_id IN (
        SELECT id FROM dim_dontes_datum
        WHERE value <= ${sqlString(state.dontesDateTo)}
      )
    `);
  }

  if (state.amountMin) {
    clauses.push(`f.odaitelt_teljes_tamogatasi_osszeg >= ${Number(state.amountMin)}`);
  }

  if (state.amountMax) {
    clauses.push(`f.odaitelt_teljes_tamogatasi_osszeg <= ${Number(state.amountMax)}`);
  }

  if (state.igenyeltMin) {
    clauses.push(`f.igenyelt_koltsegvetesi_tamogatas_osszege >= ${Number(state.igenyeltMin)}`);
  }

  if (state.igenyeltMax) {
    clauses.push(`f.igenyelt_koltsegvetesi_tamogatas_osszege <= ${Number(state.igenyeltMax)}`);
  }

  if (state.igenyloEq) {
    clauses.push(
      `f.tamogatasi_igeny_benyujtojanak_megnevezese = ${sqlString(state.igenyloEq)}`
    );
  }

  if (state.celEq) {
    clauses.push(
      `f.tamogatasi_igeny_celja = ${sqlString(state.celEq)}`
    );
  }

  if (state.search) {
    const tokens = parseSearchQuery(state.search);
    for (const tok of tokens) {
      // search_blob is the precomputed lower-cased concatenation of the
      // igénylő and cél columns (built in export_to_parquet.py). A single
      // contains() scan is ~2× faster than two ILIKEs and ~30% faster than
      // contains()+lower() at query time. Needle lowercased via DuckDB's
      // lower() to match the column's Unicode folding.
      const needle = sqlString(String(tok.text));
      const match = `contains(f.search_blob, lower(${needle}))`;
      clauses.push(tok.negate ? `NOT ${match}` : match);
    }
  }

  return clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
}

// Tokenizes a search query into {text, negate} entries.
// Supports:
//   word           -> include substring
//   -word          -> exclude substring
//   "two words"    -> include exact phrase (treated as one token)
//   -"two words"   -> exclude exact phrase
// Unterminated quotes are accepted (rest of string is the phrase).
function parseSearchQuery(input) {
  const tokens = [];
  const s = String(input);
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    let negate = false;
    if (s[i] === "-") {
      negate = true;
      i++;
    }
    let text;
    if (s[i] === '"') {
      i++;
      const end = s.indexOf('"', i);
      if (end === -1) {
        text = s.slice(i);
        i = s.length;
      } else {
        text = s.slice(i, end);
        i = end + 1;
      }
    } else {
      let j = i;
      while (j < s.length && !/\s/.test(s[j])) j++;
      text = s.slice(i, j);
      i = j;
    }
    if (text) tokens.push({ text, negate });
  }
  return tokens;
}

function escapeIlikeLiteral(s) {
  // Retained for any future ILIKE callers; current search uses contains().
  return String(s).replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function buildOrderBy(state) {
  const col = SORT_COLUMNS[state.sort] ?? SORT_COLUMNS.odaitelt;
  const dir = state.dir === "asc" ? "ASC" : "DESC";
  // NULLS LAST keeps empty values out of the top of any sort direction.
  return `ORDER BY ${col.expr} ${dir} NULLS LAST, f.id ASC`;
}

function buildSortJoin(state) {
  const col = SORT_COLUMNS[state.sort] ?? SORT_COLUMNS.odaitelt;
  return col.join;
}

function readStateFromForm() {
  return {
    search: $("search").value.trim(),
    megye: $("megye").value,
    statusz: $("statusz").value,
    lezaras: $("lezaras").value,
    palyazat: $("palyazat").value,
    tipus: $("tipus").value,
    konstrukcio: $("konstrukcio").value.trim(),
    dontesre: $("dontesre").value.trim(),
    igenyloEq: $("igenyloEq").value.trim(),
    celEq: $("celEq").value.trim(),
    dateFrom: $("dateFrom").value,
    dateTo: $("dateTo").value,
    dontesDateFrom: $("dontesDateFrom").value,
    dontesDateTo: $("dontesDateTo").value,
    igenyeltMin: $("igenyeltMin").value,
    igenyeltMax: $("igenyeltMax").value,
    amountMin: $("amountMin").value,
    amountMax: $("amountMax").value,
    sort: currentState.sort,
    dir: currentState.dir,
    page: currentState.page,
    pageSize: Number($("pageSize").value) || DEFAULT_STATE.pageSize,
  };
}

function writeStateToForm(state) {
  $("search").value = state.search;
  $("megye").value = state.megye;
  $("statusz").value = state.statusz;
  $("lezaras").value = state.lezaras;
  $("palyazat").value = state.palyazat;
  $("tipus").value = state.tipus;
  $("konstrukcio").value = state.konstrukcio;
  $("dontesre").value = state.dontesre;
  $("igenyloEq").value = state.igenyloEq;
  $("celEq").value = state.celEq;
  $("dateFrom").value = state.dateFrom;
  $("dateTo").value = state.dateTo;
  $("dontesDateFrom").value = state.dontesDateFrom;
  $("dontesDateTo").value = state.dontesDateTo;
  $("igenyeltMin").value = state.igenyeltMin;
  $("igenyeltMax").value = state.igenyeltMax;
  $("amountMin").value = state.amountMin;
  $("amountMax").value = state.amountMax;
  $("pageSize").value = String(state.pageSize);
}

function encodeStateToHash(state) {
  const params = new URLSearchParams();

  for (const [key, defaultValue] of Object.entries(DEFAULT_STATE)) {
    const value = state[key];
    if (value === defaultValue || value === "" || value === null || value === undefined) {
      continue;
    }
    params.set(key, String(value));
  }

  const encoded = params.toString();
  const newHash = encoded ? `#${encoded}` : "";

  if (newHash !== window.location.hash) {
    history.replaceState(null, "", newHash || window.location.pathname + window.location.search);
  }
}

function decodeStateFromHash() {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : window.location.hash;

  const params = new URLSearchParams(hash);
  const state = { ...DEFAULT_STATE };

  for (const key of Object.keys(DEFAULT_STATE)) {
    if (!params.has(key)) continue;
    const raw = params.get(key);

    if (key === "page" || key === "pageSize") {
      const n = Number(raw);
      state[key] = Number.isFinite(n) && n > 0 ? n : DEFAULT_STATE[key];
    } else {
      state[key] = raw;
    }
  }

  return state;
}

function updateSortIndicators() {
  for (const th of document.querySelectorAll("#results th[data-sort]")) {
    const key = th.dataset.sort;
    if (key === currentState.sort) {
      th.dataset.dir = currentState.dir;
    } else {
      delete th.dataset.dir;
    }
  }
}

async function refresh() {
  const token = ++queryToken;
  setStatus("Lekérdezés…");

  const state = currentState;
  const where = buildWhere(state);
  const orderBy = buildOrderBy(state);
  const sortJoin = buildSortJoin(state);
  const offset = (state.page - 1) * state.pageSize;

  try {
    // Results query: lean — only the sort-required JOIN is included.
    // All dim-value lookups happen in JS via dimCache to avoid forcing
    // DuckDB to materialise 2.7M wide rows for ORDER BY.
    const resultRows = await query(`
      SELECT
        f.id,
        f.igenyles_azonositoja AS azonosito,
        f.tamogatasi_igeny_benyujtojanak_megnevezese AS igenylo,
        f.tamogatasi_igeny_celja AS cel,
        f.tipus_id,
        f.szekhely_lakcim_megye_id AS megye_id,
        f.palyazat_id,
        f.tamogatasi_konstrukcio_id AS konstrukcio_id,
        f.dontesre_jogosult_szemely_vagy_testulet_id AS dontesre_id,
        f.igenyles_statusza_id AS statusz_id,
        f.lezaras_oka_id AS lezaras_id,
        f.igenyles_datuma_id,
        f.tamogatasi_dontes_datuma_id AS dontes_datuma_id,
        f.kezdodatum_id,
        f.vegdatum_id,
        f.igenyelt_koltsegvetesi_tamogatas_osszege AS igenyelt,
        f.odaitelt_teljes_tamogatasi_osszeg AS odaitelt,
        f.tamogatas_az_igenyles_szazalekaban AS szazalek
      FROM fact f
      ${sortJoin}
      ${where}
      ${orderBy}
      LIMIT ${Number(state.pageSize)} OFFSET ${Number(offset)}
    `);

    if (token !== queryToken) return;
    renderResults(resultRows);

    // Summary: aggregate per igénylés-dátum dim id (≤ ~9k groups) and roll
    // the inflation-adjusted totals up in JS. This avoids any correlated
    // subquery / per-row dim lookup in SQL, which was the previous OOM cause.
    const groupRows = await query(`
      SELECT
        f.igenyles_datuma_id AS dt_id,
        COUNT(*) AS cnt,
        SUM(f.igenyelt_koltsegvetesi_tamogatas_osszege) AS s_igenyelt,
        SUM(f.odaitelt_teljes_tamogatasi_osszeg) AS s_odaitelt,
        MIN(f.tamogatasi_dontes_datuma_id) AS min_dontes_id,
        MAX(f.tamogatasi_dontes_datuma_id) AS max_dontes_id
      FROM fact f
      ${where}
      GROUP BY f.igenyles_datuma_id
    `);

    if (token !== queryToken) return;

    let total = 0;
    let sumRequested = 0;
    let sumAwarded = 0;
    let sumRequestedReal = 0;
    let sumAwardedReal = 0;
    let minDontesId = null;
    let maxDontesId = null;

    for (const g of groupRows) {
      const cnt = Number(g.cnt) || 0;
      const sReq = Number(g.s_igenyelt) || 0;
      const sAwd = Number(g.s_odaitelt) || 0;
      const dateStr = dimLookup("igenyles_datum", g.dt_id);
      const mult = inflationMultiplierFor(dateStr);

      total += cnt;
      sumRequested += sReq;
      sumAwarded += sAwd;
      sumRequestedReal += sReq * mult;
      sumAwardedReal += sAwd * mult;

      if (g.min_dontes_id !== null && g.min_dontes_id !== undefined) {
        const v = Number(g.min_dontes_id);
        if (minDontesId === null || v < minDontesId) minDontesId = v;
      }
      if (g.max_dontes_id !== null && g.max_dontes_id !== undefined) {
        const v = Number(g.max_dontes_id);
        if (maxDontesId === null || v > maxDontesId) maxDontesId = v;
      }
    }

    $("count").textContent = formatNumber(total);
    $("sumRequested").textContent = formatNumber(sumRequested);
    $("sumAwarded").textContent = formatNumber(sumAwarded);
    $("sumRequestedReal").textContent = formatReal(sumRequestedReal);
    $("sumAwardedReal").textContent = formatReal(sumAwardedReal);

    // Döntés dátuma range. The dim is value-ordered, so MIN/MAX of the id
    // correspond to the earliest/latest decision date in the result set.
    const minDontes = minDontesId !== null ? dimLookup("dontes_datum", minDontesId) : null;
    const maxDontes = maxDontesId !== null ? dimLookup("dontes_datum", maxDontesId) : null;
    let dontesText = "–";
    if (minDontes && maxDontes) {
      dontesText = minDontes === maxDontes ? minDontes : `${minDontes} – ${maxDontes}`;
    }
    $("dontesRange").textContent = dontesText;

    renderPager(total);
    setStatus("");
  } catch (err) {
    if (token !== queryToken) return;
    console.error(err);
    setStatus(`Hiba: ${err.message ?? err}`, "error");
  }
}

function formatPercent(n) {
  if (n === null || n === undefined) return "–";
  return `${new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 2 }).format(Number(n))}%`;
}

function formatReal(n) {
  if (n === null || n === undefined) return "–";
  return new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 0 }).format(Number(n));
}

const RESULTS_COLUMN_COUNT = 19;

function dimLookup(key, id) {
  if (id === null || id === undefined) return null;
  const dim = dimCache[key];
  if (!dim) return null;
  return dim.map.get(Number(id)) ?? null;
}

function inflationMultiplierFor(dateStr) {
  if (!dateStr || dateStr.length < 4) return 1;
  const year = parseInt(dateStr.slice(0, 4), 10);
  if (!Number.isFinite(year)) return 1;
  return INFLATION_MULTS[year] ?? 1;
}

const GSEARCH_SVG =
  '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">' +
  '<circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" stroke-width="1.5"/>' +
  '<line x1="10.4" y1="10.4" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>' +
  '</svg>';

function googleLink(value) {
  if (value === null || value === undefined || value === "") return "";
  const url = `https://www.google.com/search?q=${encodeURIComponent(String(value))}`;
  return (
    `<a class="gsearch" href="${escapeHtml(url)}" target="_blank" ` +
    `rel="noopener noreferrer" title="Keresés a Google-on" ` +
    `aria-label="Keresés a Google-on">${GSEARCH_SVG}</a>`
  );
}

function filterButton(key, value) {
  if (value === null || value === undefined || value === "") return "–";
  const v = escapeHtml(value);
  return (
    `<button type="button" class="filter-add" ` +
    `data-filter-key="${escapeHtml(key)}" data-filter-value="${v}" ` +
    `title="Szűrő hozzáadása">${v}</button>`
  );
}

function renderResults(rows) {
  const body = $("results").querySelector("tbody");
  body.innerHTML = "";

  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="${RESULTS_COLUMN_COUNT}" class="empty">Nincs találat.</td>`;
    body.appendChild(tr);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    const igenylesDatum = dimLookup("igenyles_datum", row.igenyles_datuma_id);
    const mult = inflationMultiplierFor(igenylesDatum);
    const igenyeltReal =
      row.igenyelt === null || row.igenyelt === undefined
        ? null
        : Number(row.igenyelt) * mult;
    const odaiteltReal =
      row.odaitelt === null || row.odaitelt === undefined
        ? null
        : Number(row.odaitelt) * mult;

    const dontesreVal = dimLookup("dontesre", row.dontesre_id);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${filterButton("igenyloEq", row.igenylo)}${googleLink(row.igenylo)}</td>
      <td class="cel">${filterButton("celEq", row.cel)}${googleLink(row.cel)}</td>
      <td>${escapeHtml(dimLookup("konstrukcio", row.konstrukcio_id))}</td>
      <td>${escapeHtml(dimLookup("palyazat", row.palyazat_id))}</td>
      <td>${filterButton("dontesre", dontesreVal)}</td>
      <td class="num">${formatNumber(row.igenyelt)}</td>
      <td class="num">${formatNumber(row.odaitelt)}</td>
      <td class="num real">${formatReal(igenyeltReal)}</td>
      <td class="num real">${formatReal(odaiteltReal)}</td>
      <td class="num">${formatPercent(row.szazalek)}</td>
      <td>${escapeHtml(igenylesDatum)}</td>
      <td>${escapeHtml(dimLookup("dontes_datum", row.dontes_datuma_id))}</td>
      <td>${escapeHtml(dimLookup("kezdodatum", row.kezdodatum_id))}</td>
      <td>${escapeHtml(dimLookup("vegdatum", row.vegdatum_id))}</td>
      <td>${escapeHtml(dimLookup("statusz", row.statusz_id))}</td>
      <td>${escapeHtml(dimLookup("megye", row.megye_id))}</td>
      <td>${escapeHtml(dimLookup("tipus", row.tipus_id))}</td>
      <td>${escapeHtml(dimLookup("lezaras", row.lezaras_id))}</td>
      <td class="mono">${escapeHtml(row.azonosito)}</td>
    `;
    fragment.appendChild(tr);
  }
  body.appendChild(fragment);
}

function renderPager(total) {
  const state = currentState;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));

  if (state.page > totalPages) {
    state.page = totalPages;
  }

  const from = total === 0 ? 0 : (state.page - 1) * state.pageSize + 1;
  const to = Math.min(total, state.page * state.pageSize);

  const infoText =
    total === 0
      ? "0 találat"
      : `${formatNumber(from)}–${formatNumber(to)} / ${formatNumber(total)}`;

  for (const id of ["pageInfo", "pageInfoBottom"]) {
    const el = $(id);
    if (el) el.textContent = infoText;
  }

  const prevDisabled = state.page <= 1;
  const nextDisabled = state.page >= totalPages;
  for (const id of ["prevPage", "prevPageBottom"]) {
    const el = $(id);
    if (el) el.disabled = prevDisabled;
  }
  for (const id of ["nextPage", "nextPageBottom"]) {
    const el = $(id);
    if (el) el.disabled = nextDisabled;
  }
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function commitFromForm({ resetPage = true } = {}) {
  if (restoringFromUrl) return;

  const next = readStateFromForm();
  if (resetPage) next.page = 1;

  currentState = next;
  encodeStateToHash(currentState);
  updateSortIndicators();
  updateFilterActiveStyles();
  refresh();
}

// Filter ids whose value (when non-empty) actively constrains the result
// set. Used to paint the field background so it's obvious at a glance.
const FILTER_INPUT_IDS = [
  "search", "megye", "statusz", "lezaras", "palyazat", "tipus",
  "konstrukcio", "dontesre", "igenyloEq", "celEq",
  "dateFrom", "dateTo", "dontesDateFrom", "dontesDateTo",
  "igenyeltMin", "igenyeltMax", "amountMin", "amountMax",
];

function updateFilterActiveStyles() {
  for (const id of FILTER_INPUT_IDS) {
    const el = $(id);
    if (!el) continue;
    const v = (el.value ?? "").trim();
    el.classList.toggle("has-value", v !== "");
  }
}

const commitFromFormDebounced = debounce(() => commitFromForm({ resetPage: true }), 300);

function attachEvents() {
  const debouncedInputs = [
    "search", "konstrukcio", "dontesre",
    "igenyloEq", "celEq",
    "igenyeltMin", "igenyeltMax",
    "amountMin", "amountMax",
  ];
  for (const id of debouncedInputs) {
    $(id).addEventListener("input", commitFromFormDebounced);
  }

  const immediateInputs = [
    "megye", "statusz", "lezaras", "palyazat", "tipus",
    "dateFrom", "dateTo", "dontesDateFrom", "dontesDateTo",
  ];
  for (const id of immediateInputs) {
    $(id).addEventListener("change", () => commitFromForm({ resetPage: true }));
  }

  $("pageSize").addEventListener("change", () => commitFromForm({ resetPage: true }));

  const goPrev = () => {
    if (currentState.page <= 1) return;
    currentState.page -= 1;
    encodeStateToHash(currentState);
    refresh();
  };
  const goNext = () => {
    currentState.page += 1;
    encodeStateToHash(currentState);
    refresh();
  };
  $("prevPage").addEventListener("click", goPrev);
  $("nextPage").addEventListener("click", goNext);
  $("prevPageBottom").addEventListener("click", goPrev);
  $("nextPageBottom").addEventListener("click", goNext);

  $("exportCsv").addEventListener("click", exportCsv);

  const shareBtn = $("shareLink");
  if (shareBtn) {
    shareBtn.addEventListener("click", async () => {
      // The current URL (incl. hash) already encodes every filter, sort,
      // and page — see encodeStateToHash. Copying it gives a shareable
      // deep link to the exact view.
      const url = window.location.href;
      const original = shareBtn.textContent;
      const flash = (msg) => {
        shareBtn.textContent = msg;
        shareBtn.classList.add("copied");
        setTimeout(() => {
          shareBtn.textContent = original;
          shareBtn.classList.remove("copied");
        }, 1500);
      };
      try {
        await navigator.clipboard.writeText(url);
        flash("Link vágólapra másolva");
      } catch {
        // Clipboard API can fail without a secure context or user gesture
        // on some browsers; fall back to prompting the URL for manual copy.
        window.prompt("Másold ki a linket:", url);
      }
    });
  }

  $("reset").addEventListener("click", () => {
    currentState = { ...DEFAULT_STATE };
    restoringFromUrl = true;
    writeStateToForm(currentState);
    restoringFromUrl = false;
    encodeStateToHash(currentState);
    updateSortIndicators();
    updateFilterActiveStyles();
    refresh();
  });

  for (const th of document.querySelectorAll("#results th[data-sort]")) {
    th.addEventListener("click", (e) => {
      // Ignore clicks that originated on the resize handle.
      if (e.target.closest(".col-resize-handle")) return;
      const key = th.dataset.sort;
      if (currentState.sort === key) {
        currentState.dir = currentState.dir === "asc" ? "desc" : "asc";
      } else {
        currentState.sort = key;
        const ascDefaults = new Set([
          "igenylo", "tipus", "megye", "palyazat", "konstrukcio",
          "statusz", "lezaras", "dontesre", "azonosito",
        ]);
        currentState.dir = ascDefaults.has(key) ? "asc" : "desc";
      }
      currentState.page = 1;
      encodeStateToHash(currentState);
      updateSortIndicators();
      refresh();
    });
  }

  window.addEventListener("hashchange", () => {
    const hashState = decodeStateFromHash();
    if (JSON.stringify(hashState) === JSON.stringify(currentState)) return;
    currentState = hashState;
    restoringFromUrl = true;
    writeStateToForm(currentState);
    restoringFromUrl = false;
    updateSortIndicators();
    updateFilterActiveStyles();
    refresh();
  });

  // Click-to-filter on cells marked as filter-add (igénylő, cél, döntésre).
  $("results").addEventListener("click", (e) => {
    const btn = e.target.closest("button.filter-add");
    if (!btn) return;
    e.preventDefault();
    const key = btn.dataset.filterKey;
    const value = btn.dataset.filterValue ?? "";
    const input = $(key);
    if (!input) return;
    input.value = value;
    commitFromForm({ resetPage: true });
  });

  setupColumnResize();
}

function setupColumnResize() {
  const table = $("results");
  const cols = Array.from(table.querySelectorAll("colgroup col"));
  const ths = Array.from(table.querySelectorAll("thead th"));
  if (cols.length === 0 || cols.length !== ths.length) return;

  for (let i = 0; i < ths.length; i++) {
    const th = ths[i];
    const col = cols[i];
    const handle = document.createElement("div");
    handle.className = "col-resize-handle";
    handle.title = "Húzd az oszlopszélesség állításához";
    th.appendChild(handle);

    handle.addEventListener("click", (e) => e.stopPropagation());

    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth =
        col.offsetWidth || parseInt(col.style.width, 10) || 100;
      handle.classList.add("dragging");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev) => {
        const newWidth = Math.max(40, startWidth + (ev.clientX - startX));
        col.style.width = newWidth + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        handle.classList.remove("dragging");
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
}

const CSV_EXPORT_LIMIT = 100000;

const CSV_HEADERS = [
  "Igénylő", "Cél", "Konstrukció", "Pályázat", "Döntésre jogosult",
  "Igényelt (Ft)", "Odaítélt (Ft)",
  "Igényelt (2025 Ft)", "Odaítélt (2025 Ft)", "%",
  "Igénylés dátuma", "Döntés dátuma", "Kezdő dátum", "Vég dátum",
  "Státusz", "Megye", "Típus", "Lezárás oka", "Azonosító",
];

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replaceAll('"', '""') + '"';
  }
  return s;
}

function csvRow(values) {
  return values.map(csvCell).join(",");
}

function csvNumber(n) {
  if (n === null || n === undefined) return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  return String(num);
}

async function exportCsv() {
  const button = $("exportCsv");
  const state = currentState;
  const where = buildWhere(state);
  const orderBy = buildOrderBy(state);
  const sortJoin = buildSortJoin(state);

  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = "Exportálás…";
  setStatus("CSV exportálás…");

  try {
    // Pull one extra row to detect truncation.
    const rows = await query(`
      SELECT
        f.id,
        f.igenyles_azonositoja AS azonosito,
        f.tamogatasi_igeny_benyujtojanak_megnevezese AS igenylo,
        f.tamogatasi_igeny_celja AS cel,
        f.tipus_id,
        f.szekhely_lakcim_megye_id AS megye_id,
        f.palyazat_id,
        f.tamogatasi_konstrukcio_id AS konstrukcio_id,
        f.dontesre_jogosult_szemely_vagy_testulet_id AS dontesre_id,
        f.igenyles_statusza_id AS statusz_id,
        f.lezaras_oka_id AS lezaras_id,
        f.igenyles_datuma_id,
        f.tamogatasi_dontes_datuma_id AS dontes_datuma_id,
        f.kezdodatum_id,
        f.vegdatum_id,
        f.igenyelt_koltsegvetesi_tamogatas_osszege AS igenyelt,
        f.odaitelt_teljes_tamogatasi_osszeg AS odaitelt,
        f.tamogatas_az_igenyles_szazalekaban AS szazalek
      FROM fact f
      ${sortJoin}
      ${where}
      ${orderBy}
      LIMIT ${CSV_EXPORT_LIMIT + 1}
    `);

    const truncated = rows.length > CSV_EXPORT_LIMIT;
    const exportRows = truncated ? rows.slice(0, CSV_EXPORT_LIMIT) : rows;

    if (truncated) {
      const ok = confirm(
        `A szűrt nézet ${formatNumber(CSV_EXPORT_LIMIT)}+ sort tartalmaz. ` +
          `Csak az első ${formatNumber(CSV_EXPORT_LIMIT)} sor kerül exportálásra. Folytatod?`
      );
      if (!ok) {
        setStatus("");
        return;
      }
    }

    const lines = [csvRow(CSV_HEADERS)];
    for (const row of exportRows) {
      const dateStr = dimLookup("igenyles_datum", row.igenyles_datuma_id);
      const mult = inflationMultiplierFor(dateStr);
      const igReal =
        row.igenyelt === null || row.igenyelt === undefined
          ? null
          : Number(row.igenyelt) * mult;
      const odReal =
        row.odaitelt === null || row.odaitelt === undefined
          ? null
          : Number(row.odaitelt) * mult;

      lines.push(
        csvRow([
          row.igenylo,
          row.cel,
          dimLookup("konstrukcio", row.konstrukcio_id),
          dimLookup("palyazat", row.palyazat_id),
          dimLookup("dontesre", row.dontesre_id),
          csvNumber(row.igenyelt),
          csvNumber(row.odaitelt),
          csvNumber(igReal !== null ? Math.round(igReal) : null),
          csvNumber(odReal !== null ? Math.round(odReal) : null),
          csvNumber(row.szazalek),
          dateStr,
          dimLookup("dontes_datum", row.dontes_datuma_id),
          dimLookup("kezdodatum", row.kezdodatum_id),
          dimLookup("vegdatum", row.vegdatum_id),
          dimLookup("statusz", row.statusz_id),
          dimLookup("megye", row.megye_id),
          dimLookup("tipus", row.tipus_id),
          dimLookup("lezaras", row.lezaras_id),
          row.azonosito,
        ])
      );
    }

    // Prepend BOM so Excel opens it as UTF-8.
    const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
    a.href = url;
    a.download = `tamogatasok-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    setStatus(
      truncated
        ? `Exportálva: ${formatNumber(exportRows.length)} sor (csonkolva).`
        : `Exportálva: ${formatNumber(exportRows.length)} sor.`
    );
    setTimeout(() => setStatus(""), 4000);
  } catch (err) {
    console.error(err);
    setStatus(`CSV export hiba: ${err.message ?? err}`, "error");
  } finally {
    button.textContent = originalLabel;
    button.disabled = false;
  }
}

async function main() {
  try {
    if (IS_FILE_PROTOCOL || OFFLINE_DUCKDB_WASM_NAME) {
      // Show the file picker overlay FIRST so the user sees it instantly,
      // before DuckDB-WASM and the CDN module fetches kick in. Offline
      // builds always need the picker (to load the bundled WASM runtime).
      localBuffers = await waitForLocalFiles();
    }

    setStatus("Adatbázis betöltése…");
    await initDuckDB();
    await createViews();
    await loadDimensions();
    populateFilters();

    currentState = decodeStateFromHash();
    restoringFromUrl = true;
    writeStateToForm(currentState);
    restoringFromUrl = false;
    updateSortIndicators();
    updateFilterActiveStyles();

    attachEvents();

    await refresh();
  } catch (err) {
    console.error(err);
    setStatus(`Hiba az inicializálás során: ${err.message ?? err}`, "error");
  }
}

main();
