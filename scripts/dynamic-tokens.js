const MODULE_ID = "dynamic-tokens";

/* ---------------------------------------- */
/*  Helpers                                  */
/* ---------------------------------------- */

/**
 * Resolve a dot-delimited path on an object.
 * e.g. resolvePath(actor, "system.resources.hitPoints") → actor.system.resources.hitPoints
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
    hint: 'The dot-path on the actor where HP lives. The module reads .value and .max from this path. Example for Daggerheart: system.resources.hitPoints. Example for D&D 5e: system.attributes.hp.',
    scope: "world",
    config: true,
    type: String,
    default: "system.resources.hitPoints",
  });
});

/* ---------------------------------------- */
/*  Render TokenConfig — inject into         */
/*  appearance tab as a fieldset             */
/* ---------------------------------------- */

/**
 * Shared handler for injecting the Dynamic Tokens fieldset into the appearance tab.
 */
async function onRenderTokenConfig(app, element) {
  const tokenDoc = app.document ?? app.token;
  if (!tokenDoc) return;

  // Avoid duplicate injection on re-render
  if (element.querySelector(".dynamic-tokens-fieldset")) return;

  // Find the appearance tab
  const appearanceTab = element.querySelector('[data-tab="appearance"]');
  if (!appearanceTab) return;

  // Load the handlebars template
  const templatePath = `modules/${MODULE_ID}/templates/token-config-tab.hbs`;
  const thresholds = getThresholds(tokenDoc) ?? [];
  const html = await renderTemplate(templatePath, { thresholds });

  // Create a fieldset matching Foundry's native styling
  const fieldset = document.createElement("fieldset");
  fieldset.classList.add("dynamic-tokens-fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "Dynamic Token Images";
  fieldset.appendChild(legend);

  const container = document.createElement("div");
  container.innerHTML = html;
  fieldset.appendChild(container);

  // Append at the bottom of the appearance tab
  appearanceTab.appendChild(fieldset);

  // Wire up event listeners
  activateListeners(fieldset, tokenDoc);
}

// Hook into both placed-token config and prototype-token config
Hooks.on("renderTokenConfig", (app, element, context, options) => onRenderTokenConfig(app, element));
Hooks.on("renderPrototypeTokenConfig", (app, element, context, options) => onRenderTokenConfig(app, element));

/**
 * Attach interactive listeners to the dynamic-tokens fieldset.
 */
function activateListeners(fieldset, tokenDoc) {
  // "Add Threshold" button
  fieldset.querySelector(".dt-add-threshold")?.addEventListener("click", () => {
    const container = fieldset.querySelector(".dynamic-tokens-thresholds");
    const index = container.querySelectorAll(".threshold-row").length;
    const row = document.createElement("div");
    row.classList.add("threshold-row");
    row.dataset.index = index;
    row.innerHTML = `
      <div class="form-fields">
        <label>HP &le;</label>
        <input type="number" class="dt-threshold" value="100" min="0" max="100" step="1" placeholder="%" />
        <span>%</span>
        <input type="text" class="dt-img" value="" placeholder="path/to/image.png" />
        <button type="button" class="dt-file-picker" title="Browse Files">
          <i class="fa-solid fa-file-import"></i>
        </button>
        <button type="button" class="dt-remove" title="Remove Threshold">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>
    `;
    container.appendChild(row);
    activateRowListeners(row, fieldset, tokenDoc);
  });

  // Existing rows
  fieldset.querySelectorAll(".threshold-row").forEach((row) => {
    activateRowListeners(row, fieldset, tokenDoc);
  });

  // Auto-save on any input change (threshold value or image path)
  fieldset.addEventListener("change", () => saveThresholds(fieldset, tokenDoc));
}

/**
 * Wire up per-row buttons (file picker, delete).
 */
function activateRowListeners(row, fieldset, tokenDoc) {
  // File picker button
  row.querySelector(".dt-file-picker")?.addEventListener("click", () => {
    const imgInput = row.querySelector(".dt-img");
    new FilePicker({
      type: "image",
      current: imgInput.value,
      callback: (path) => {
        imgInput.value = path;
        saveThresholds(fieldset, tokenDoc);
      },
    }).browse();
  });

  // Delete button
  row.querySelector(".dt-remove")?.addEventListener("click", () => {
    row.remove();
    saveThresholds(fieldset, tokenDoc);
  });
}

/**
 * Read all threshold rows from the DOM and persist to token flags.
 */
async function saveThresholds(fieldset, tokenDoc) {
  const rows = fieldset.querySelectorAll(".threshold-row");
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
