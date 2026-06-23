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
 * Resolve the FilePicker class across Foundry versions.
 * The global `FilePicker` was deprecated in v13 and removed in v14;
 * the namespaced implementation is the forward-compatible reference.
 */
function getFilePicker() {
  return foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
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

/**
 * Determine whether an update payload touches a tracked attribute path.
 */
function didAttributeChange(changes, attrPath) {
  const basePath = `system.${attrPath}`;
  const valuePath = `${basePath}.value`;
  const currentPath = `${basePath}.current`;
  return (
    foundry.utils.hasProperty(changes, basePath) ||
    foundry.utils.hasProperty(changes, valuePath) ||
    foundry.utils.hasProperty(changes, currentPath)
  );
}

/**
 * Normalize an attribute object into { value, max, isReversed }.
 */
function normalizeAttribute(attrData) {
  if (attrData == null) return null;
  if (typeof attrData !== "object") return null;
  const value = attrData.value ?? attrData.current;
  const max = attrData.max ?? attrData.maximum;
  const isReversed = attrData.isReversed ?? attrData.reversed ?? false;
  if (value == null || max == null) return null;
  return { value, max, isReversed };
}

/**
 * Compute the matching image for a token from its actor's current attribute,
 * and swap the texture if it differs. Idempotent — safe to call repeatedly.
 */
async function refreshToken(tokenDoc) {
  const attrPath = getAttribute(tokenDoc);
  if (!attrPath) return;

  const thresholds = getThresholds(tokenDoc);
  if (!thresholds?.length) return;

  const actor = tokenDoc.actor;
  if (!actor) return;

  const attrData = normalizeAttribute(resolvePath(actor, "system." + attrPath));
  if (!attrData || !attrData.max || attrData.max === 0) return;

  // If isReversed (e.g. Daggerheart), value counts damage taken: 0 = full, max = dead
  const hpPercent = attrData.isReversed
    ? (1 - attrData.value / attrData.max) * 100
    : (attrData.value / attrData.max) * 100;

  const newImg = resolveImage(hpPercent, thresholds);
  if (!newImg) return;

  if (tokenDoc.texture?.src !== newImg) {
    await tokenDoc.update({ "texture.src": newImg });
  }
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
  legend.textContent = game.i18n.localize("DYNAMIC_TOKENS.Legend");
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
Hooks.on("renderTokenConfig", (app, element) => onRenderTokenConfig(app, element));
Hooks.on("renderPrototypeTokenConfig", (app, element) => onRenderTokenConfig(app, element));

/**
 * Attach interactive listeners to the dynamic-tokens fieldset.
 */
function activateListeners(fieldset, tokenDoc) {
  // Attribute selector — save on change, then refresh image immediately
  fieldset.querySelector(".dt-attribute")?.addEventListener("change", async (e) => {
    await tokenDoc.setFlag(MODULE_ID, "attribute", e.target.value);
    refreshToken(tokenDoc);
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
        <label>${game.i18n.localize("DYNAMIC_TOKENS.HpAtMost")}</label>
        <input type="number" class="dt-threshold" value="100" min="0" max="100" step="1" placeholder="%" />
        <span>%</span>
        <img class="dt-thumb empty" src="" alt="" />
        <input type="text" class="dt-img" value="" placeholder="${game.i18n.localize("DYNAMIC_TOKENS.ImagePlaceholder")}" />
        <button type="button" class="dt-file-picker" title="${game.i18n.localize("DYNAMIC_TOKENS.BrowseFiles")}">
          <i class="fa-solid fa-file-import"></i>
        </button>
        <button type="button" class="dt-remove" title="${game.i18n.localize("DYNAMIC_TOKENS.RemoveThreshold")}">
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

  // Auto-save thresholds on any threshold input change (the attribute select
  // manages its own flag, so ignore changes that bubble from it)
  fieldset.addEventListener("change", (e) => {
    if (e.target.classList?.contains("dt-attribute")) return;
    saveThresholds(fieldset, tokenDoc);
  });
}

/**
 * Wire up per-row buttons (file picker, delete).
 */
function activateRowListeners(row, fieldset, tokenDoc) {
  const imgInput = row.querySelector(".dt-img");

  // Keep the preview thumbnail in sync with the path field
  imgInput?.addEventListener("input", () => updateThumb(row));

  row.querySelector(".dt-file-picker")?.addEventListener("click", () => {
    const FP = getFilePicker();
    new FP({
      type: "image",
      current: imgInput.value,
      callback: (path) => {
        imgInput.value = path;
        updateThumb(row);
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
 * Refresh a row's preview thumbnail from its path field.
 */
function updateThumb(row) {
  const thumb = row.querySelector(".dt-thumb");
  const path = row.querySelector(".dt-img")?.value?.trim() ?? "";
  if (!thumb) return;
  thumb.src = path;
  thumb.classList.toggle("empty", !path);
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
  // Apply the new configuration immediately so the GM sees the effect
  refreshToken(tokenDoc);
}

/* ---------------------------------------- */
/*  React to HP changes & scene load         */
/* ---------------------------------------- */

Hooks.on("updateActor", async (actor, changes, options, userId) => {
  // Only run on the triggering user's client to avoid duplicate updates
  if (game.user.id !== userId) return;

  // Process all active tokens for this actor on the current scene
  const tokens = actor.getActiveTokens(false, true);
  for (const tokenDoc of tokens) {
    const attrPath = getAttribute(tokenDoc);
    if (!attrPath) continue;
    // Skip work unless this update touched the tracked attribute
    if (!didAttributeChange(changes, attrPath)) continue;
    await refreshToken(tokenDoc);
  }
});

// Sync a token's image to current HP when it is placed on the scene.
Hooks.on("createToken", async (tokenDoc, options, userId) => {
  if (game.user.id !== userId) return;
  await refreshToken(tokenDoc);
});

// Sync every token's image to current HP when a scene is rendered.
Hooks.on("canvasReady", async (canvas) => {
  // Let the active GM own the canonical update to avoid duplicate writes
  if (!game.users.activeGM || game.user.id !== game.users.activeGM.id) return;
  for (const token of canvas.tokens?.placeables ?? []) {
    await refreshToken(token.document);
  }
});
