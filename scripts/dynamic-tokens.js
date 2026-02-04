const MODULE_ID = "dynamic-tokens";
const DEFAULT_ATTRIBUTE = "resources.hitPoints";

/* ---------------------------------------- */
/*  Helpers                                  */
/* ---------------------------------------- */

/**
 * Resolve a dot-delimited path on an object.
 */
function resolvePath(obj, path) {
  return path.split(".").reduce((o, key) => o?.[key], obj);
}

/**
 * Read thresholds from a token document's flags.
 */
function getThresholds(tokenDoc) {
  return tokenDoc.getFlag(MODULE_ID, "thresholds") ?? null;
}

/**
 * Read the tracked attribute path from a token document's flags.
 * Returns the path relative to actor.system (e.g. "resources.hitPoints").
 */
function getAttribute(tokenDoc) {
  return tokenDoc.getFlag(MODULE_ID, "attribute") ?? null;
}

/**
 * Given an HP percentage (0-100) and thresholds, return the matching image path.
 * Sorts ascending — the first entry where hpPercent <= threshold is the tightest match.
 */
function resolveImage(hpPercent, thresholds) {
  if (!thresholds?.length) return null;
  const sorted = [...thresholds].sort((a, b) => a.threshold - b.threshold);
  for (const entry of sorted) {
    if (hpPercent <= entry.threshold) {
      return entry.img;
    }
  }
  return null;
}

/* ---------------------------------------- */
/*  Render TokenConfig — inject into         */
/*  appearance tab as a fieldset             */
/* ---------------------------------------- */

async function onRenderTokenConfig(app, element) {
  const tokenDoc = app.document ?? app.token;
  if (!tokenDoc) return;

  // Avoid duplicate injection on re-render
  if (element.querySelector(".dynamic-tokens-fieldset")) return;

  // Find the appearance tab content panel
  const appearanceTab = element.querySelector('div.tab[data-tab="appearance"]');
  if (!appearanceTab) return;

  // Load the handlebars template
  const templatePath = `modules/${MODULE_ID}/templates/token-config-tab.hbs`;
  const thresholds = getThresholds(tokenDoc) ?? [];
  const html = await foundry.applications.handlebars.renderTemplate(templatePath, { thresholds });

  // Create a fieldset matching Foundry's native styling
  const fieldset = document.createElement("fieldset");
  fieldset.classList.add("dynamic-tokens-fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "Dynamic Token Images";
  fieldset.appendChild(legend);

  const container = document.createElement("div");
  container.innerHTML = html;
  fieldset.appendChild(container);

  // Populate the attribute dropdown by cloning options from the bar1 selector
  const dtSelect = fieldset.querySelector(".dt-attribute");
  const barSelect = element.querySelector('select[name="bar1.attribute"]');
  if (dtSelect && barSelect) {
    // Clone all optgroups and options from Foundry's bar attribute selector
    for (const child of barSelect.children) {
      dtSelect.appendChild(child.cloneNode(true));
    }
    // Set current value from flags
    const savedAttr = getAttribute(tokenDoc) ?? DEFAULT_ATTRIBUTE;
    dtSelect.value = savedAttr;
  }

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
  // Attribute selector — save on change
  fieldset.querySelector(".dt-attribute")?.addEventListener("change", (e) => {
    tokenDoc.setFlag(MODULE_ID, "attribute", e.target.value);
  });

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

  // Auto-save thresholds on any input change
  fieldset.addEventListener("change", () => saveThresholds(fieldset, tokenDoc));
}

/**
 * Wire up per-row buttons (file picker, delete).
 */
function activateRowListeners(row, fieldset, tokenDoc) {
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

  // Process all active tokens for this actor on the current scene
  const tokens = actor.getActiveTokens(false, true);
  for (const tokenDoc of tokens) {
    const attrPath = getAttribute(tokenDoc);
    if (!attrPath) continue;

    const thresholds = getThresholds(tokenDoc);
    if (!thresholds?.length) continue;

    // Check if this attribute changed in this update
    const changePath = "system." + attrPath + ".value";
    const changedValue = foundry.utils.getProperty(changes, changePath);
    if (changedValue === undefined) continue;

    // Read current attribute data from the actor
    const attrData = resolvePath(actor, "system." + attrPath);
    if (!attrData || attrData.max == null || attrData.max === 0) continue;

    // If isReversed (e.g. Daggerheart), value counts damage taken: 0 = full, max = dead
    const hpPercent = attrData.isReversed
      ? ((1 - attrData.value / attrData.max) * 100)
      : ((attrData.value / attrData.max) * 100);

    const newImg = resolveImage(hpPercent, thresholds);
    if (!newImg) continue;

    if (tokenDoc.texture?.src !== newImg) {
      await tokenDoc.update({ "texture.src": newImg });
    }
  }
});
