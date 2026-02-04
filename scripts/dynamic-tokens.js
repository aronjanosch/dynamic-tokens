const MODULE_ID = "dynamic-tokens";

/* ---------------------------------------- */
/*  Helpers                                  */
/* ---------------------------------------- */

/**
 * Resolve a dot-delimited path on an object.
 * e.g. resolvePath(actor, "system.attributes.hp") → actor.system.attributes.hp
 */
function resolvePath(obj, path) {
  return path.split(".").reduce((o, key) => o?.[key], obj);
}

/**
 * Read thresholds from a token document's flags.
 * @returns {Array<{threshold: number, img: string}>|null}
 */
function getThresholds(tokenDoc) {
  return tokenDoc.getFlag(MODULE_ID, "thresholds") ?? null;
}

/**
 * Given an HP percentage (0-100) and a sorted-descending array of thresholds,
 * return the matching image path or null.
 */
function resolveImage(hpPercent, thresholds) {
  if (!thresholds?.length) return null;
  // Sort descending by threshold value (in case stored unsorted)
  const sorted = [...thresholds].sort((a, b) => b.threshold - a.threshold);
  for (const entry of sorted) {
    if (hpPercent <= entry.threshold) {
      return entry.img;
    }
  }
  // HP% is above all thresholds — shouldn't normally happen if 100 is present,
  // but fall back to the highest threshold's image.
  return sorted[0]?.img ?? null;
}

/* ---------------------------------------- */
/*  Init — register settings                 */
/* ---------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "hpPath", {
    name: "HP Attribute Path",
    hint: 'The dot-path on the actor where HP lives. The module reads .value and .max from this path. Default works for D&D 5e.',
    scope: "world",
    config: true,
    type: String,
    default: "system.attributes.hp",
  });
});

/* ---------------------------------------- */
/*  Render TokenConfig — inject threshold UI */
/* ---------------------------------------- */

/**
 * Shared handler for injecting the Dynamic Tokens tab into token config sheets.
 */
async function onRenderTokenConfig(app, element) {
  const tokenDoc = app.document ?? app.token;
  if (!tokenDoc) return;

  // Avoid duplicate injection on re-render
  if (element.querySelector('[data-tab="dynamic-tokens"]')) return;

  // Load the handlebars template
  const templatePath = `modules/${MODULE_ID}/templates/token-config-tab.hbs`;
  const thresholds = getThresholds(tokenDoc) ?? [];
  const html = await renderTemplate(templatePath, { thresholds });

  // Find the nav bar and the tab content area
  const nav = element.querySelector("nav.sheet-tabs, nav.tabs, [role='tablist']");
  const body = element.querySelector(".sheet-body, .window-content form, form");
  if (!nav || !body) return;

  // Add a nav tab button
  const tabBtn = document.createElement("a");
  tabBtn.classList.add("item");
  tabBtn.dataset.tab = "dynamic-tokens";
  tabBtn.dataset.group = "main";
  tabBtn.innerHTML = `<i class="fas fa-exchange-alt"></i> Dynamic Tokens`;
  nav.appendChild(tabBtn);

  // Add the tab content section
  const section = document.createElement("div");
  section.classList.add("tab");
  section.dataset.tab = "dynamic-tokens";
  section.dataset.group = "main";
  section.innerHTML = html;
  body.appendChild(section);

  // Wire up event listeners inside our section
  activateListeners(section, tokenDoc);
}

// Hook into both placed-token config and prototype-token config
Hooks.on("renderTokenConfig", (app, element, context, options) => onRenderTokenConfig(app, element));
Hooks.on("renderPrototypeTokenConfig", (app, element, context, options) => onRenderTokenConfig(app, element));

/**
 * Attach interactive listeners to the dynamic-tokens tab section.
 */
function activateListeners(section, tokenDoc) {
  // "Add Threshold" button
  section.querySelector(".dt-add-threshold")?.addEventListener("click", () => {
    const container = section.querySelector(".dynamic-tokens-thresholds");
    const index = container.querySelectorAll(".threshold-row").length;
    const row = document.createElement("div");
    row.classList.add("threshold-row");
    row.dataset.index = index;
    row.innerHTML = `
      <div class="threshold-field">
        <label>HP &le;</label>
        <input type="number" class="dt-threshold" value="100" min="0" max="100" step="1" placeholder="%" />
        <span>%</span>
      </div>
      <div class="threshold-image-field">
        <input type="text" class="dt-img" value="" placeholder="path/to/image.png" />
        <button type="button" class="dt-file-picker" data-index="${index}" title="Browse Files">
          <i class="fas fa-file-import"></i>
        </button>
      </div>
      <button type="button" class="dt-remove" data-index="${index}" title="Remove Threshold">
        <i class="fas fa-trash"></i>
      </button>
    `;
    container.appendChild(row);
    activateRowListeners(row, section, tokenDoc);
  });

  // Existing rows
  section.querySelectorAll(".threshold-row").forEach((row) => {
    activateRowListeners(row, section, tokenDoc);
  });

  // Auto-save on any input change (threshold value or image path)
  section.addEventListener("change", () => saveThresholds(section, tokenDoc));
}

/**
 * Wire up per-row buttons (file picker, delete).
 */
function activateRowListeners(row, section, tokenDoc) {
  // File picker button
  row.querySelector(".dt-file-picker")?.addEventListener("click", () => {
    const imgInput = row.querySelector(".dt-img");
    new FilePicker({
      type: "image",
      current: imgInput.value,
      callback: (path) => {
        imgInput.value = path;
        saveThresholds(section, tokenDoc);
      },
    }).browse();
  });

  // Delete button
  row.querySelector(".dt-remove")?.addEventListener("click", () => {
    row.remove();
    saveThresholds(section, tokenDoc);
  });
}

/**
 * Read all threshold rows from the DOM and persist to token flags.
 */
async function saveThresholds(section, tokenDoc) {
  const rows = section.querySelectorAll(".threshold-row");
  const thresholds = [];
  rows.forEach((row) => {
    const threshold = Number(row.querySelector(".dt-threshold")?.value ?? 100);
    const img = row.querySelector(".dt-img")?.value?.trim() ?? "";
    if (img) {
      thresholds.push({ threshold, img });
    }
  });
  await tokenDoc.setFlag(MODULE_ID, "thresholds", thresholds);
}

/* ---------------------------------------- */
/*  Update Actor — react to HP changes       */
/* ---------------------------------------- */

Hooks.on("updateActor", async (actor, changes, options, userId) => {
  // Only run on the triggering user's client to avoid duplicate updates
  if (game.user.id !== userId) return;

  const hpPath = game.settings.get(MODULE_ID, "hpPath");

  // Check if the HP value actually changed in this update
  const changePath = hpPath + ".value";
  const changedValue = foundry.utils.getProperty(changes, changePath);
  if (changedValue === undefined) return;

  // Read current HP from the actor
  const hpData = resolvePath(actor, hpPath);
  if (!hpData || hpData.max == null || hpData.max === 0) return;

  const hpPercent = (hpData.value / hpData.max) * 100;

  // Process all active tokens for this actor on the current scene
  const tokens = actor.getActiveTokens(false, true); // linked=false (all tokens), document=true (return TokenDocuments)
  for (const tokenDoc of tokens) {
    const thresholds = getThresholds(tokenDoc);
    if (!thresholds?.length) continue;

    const newImg = resolveImage(hpPercent, thresholds);
    if (!newImg) continue;

    // Only update if the image actually differs
    if (tokenDoc.texture?.src !== newImg) {
      await tokenDoc.update({ "texture.src": newImg });
    }
  }
});
