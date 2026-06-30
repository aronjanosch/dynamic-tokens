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
 * Compute a token's current HP percentage from its actor via the tracked
 * attribute. Returns null if untracked, unlinked, or max is 0.
 */
function computeHpPercent(tokenDoc) {
  const attrPath = getAttribute(tokenDoc);
  if (!attrPath) return null;

  const actor = tokenDoc.actor;
  if (!actor) return null;

  const attrData = normalizeAttribute(resolvePath(actor, "system." + attrPath));
  if (!attrData || !attrData.max) return null;

  // If isReversed (e.g. Daggerheart), value counts damage taken: 0 = full, max = dead
  return attrData.isReversed
    ? (1 - attrData.value / attrData.max) * 100
    : (attrData.value / attrData.max) * 100;
}

/**
 * Compute the matching image for a token from its actor's current attribute,
 * and swap the texture if it differs. Idempotent — safe to call repeatedly.
 */
async function refreshToken(tokenDoc) {
  const thresholds = getThresholds(tokenDoc);
  if (!thresholds?.length) return;

  const hpPercent = computeHpPercent(tokenDoc);
  if (hpPercent == null) return;

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
  // Default the preview slider to the token's actual current HP%, so the
  // fieldset opens already showing which threshold band is live.
  const currentPercent = computeHpPercent(tokenDoc);
  const previewPercent = currentPercent != null ? Math.round(currentPercent) : 100;
  const html = await foundry.applications.handlebars.renderTemplate(templatePath, {
    thresholds,
    previewPercent,
  });

  // Create a fieldset matching Foundry's native styling, with a collapsible
  // <details> body so the section can shrink once it grows (random pools etc).
  const fieldset = document.createElement("fieldset");
  fieldset.classList.add("dynamic-tokens-fieldset");

  const details = document.createElement("details");
  details.classList.add("dynamic-tokens-details");
  details.open = true;
  const summary = document.createElement("summary");
  summary.textContent = game.i18n.localize("DYNAMIC_TOKENS.Legend");
  details.appendChild(summary);

  const container = document.createElement("div");
  container.innerHTML = html;
  details.appendChild(container);
  fieldset.appendChild(details);

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
  updatePreview(fieldset, previewPercent);
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

  // Live preview slider — scrub a hypothetical HP% without touching actor HP
  const slider = fieldset.querySelector(".dt-preview-slider");
  slider?.addEventListener("input", () => updatePreview(fieldset, Number(slider.value)));
  wireThumbErrorHandling(fieldset.querySelector(".dt-preview-thumb"));

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
    refreshPreview(fieldset);
  });

  // Existing rows
  fieldset.querySelectorAll(".threshold-row").forEach((row) => {
    activateRowListeners(row, fieldset, tokenDoc);
  });

  // Auto-save thresholds on any threshold input change (the attribute select
  // and preview slider manage their own state, so ignore changes from them)
  fieldset.addEventListener("change", (e) => {
    if (e.target.classList?.contains("dt-attribute")) return;
    if (e.target.classList?.contains("dt-preview-slider")) return;
    saveThresholds(fieldset, tokenDoc);
    refreshPreview(fieldset);
  });
}

/**
 * Wire up per-row buttons (file picker, delete).
 */
function activateRowListeners(row, fieldset, tokenDoc) {
  const imgInput = row.querySelector(".dt-img");
  wireThumbErrorHandling(row.querySelector(".dt-thumb"));

  // Keep the row thumbnail and live preview in sync with the path field
  imgInput?.addEventListener("input", () => {
    updateThumb(row);
    refreshPreview(fieldset);
  });

  row.querySelector(".dt-file-picker")?.addEventListener("click", () => {
    const FP = getFilePicker();
    new FP({
      type: "image",
      current: imgInput.value,
      callback: (path) => {
        imgInput.value = path;
        updateThumb(row);
        saveThresholds(fieldset, tokenDoc);
        refreshPreview(fieldset);
      },
    }).browse();
  });

  row.querySelector(".dt-remove")?.addEventListener("click", () => {
    row.remove();
    saveThresholds(fieldset, tokenDoc);
    refreshPreview(fieldset);
  });
}

/**
 * Refresh a row's preview thumbnail from its path field.
 */
function updateThumb(row) {
  const thumb = row.querySelector(".dt-thumb");
  const path = row.querySelector(".dt-img")?.value?.trim() ?? "";
  if (!thumb) return;
  thumb.classList.remove("broken");
  thumb.src = path;
  thumb.classList.toggle("empty", !path);
}

/**
 * Add broken-image feedback to a thumbnail: a red border on load failure
 * instead of silently staying blank. Ignores thumbs with no path set.
 */
function wireThumbErrorHandling(thumb) {
  if (!thumb) return;
  thumb.addEventListener("error", () => {
    if (!thumb.classList.contains("empty")) thumb.classList.add("broken");
  });
  thumb.addEventListener("load", () => thumb.classList.remove("broken"));
}

/**
 * Read threshold rows currently in the DOM (including unsaved edits) as
 * plain { threshold, img } objects, for live preview matching.
 */
function readThresholdsFromDOM(fieldset) {
  const thresholds = [];
  fieldset.querySelectorAll(".threshold-row").forEach((row) => {
    const threshold = Number(row.querySelector(".dt-threshold")?.value ?? 100);
    const img = row.querySelector(".dt-img")?.value?.trim() ?? "";
    if (img) thresholds.push({ threshold, img });
  });
  return thresholds;
}

/**
 * Find the threshold row matching the tightest band for a given HP%,
 * mirroring resolveImage()'s ascending-sort/first-match logic.
 */
function resolveActiveRow(fieldset, hpPercent) {
  const rows = [...fieldset.querySelectorAll(".threshold-row")];
  const entries = rows
    .map((row) => ({ row, threshold: Number(row.querySelector(".dt-threshold")?.value ?? 100) }))
    .sort((a, b) => a.threshold - b.threshold);
  return entries.find((entry) => hpPercent <= entry.threshold)?.row ?? null;
}

/**
 * Update the live preview thumbnail and active-row highlight for a given
 * hypothetical HP%. Pure UI — never touches actor or token data.
 */
function updatePreview(fieldset, hpPercent) {
  const valueEl = fieldset.querySelector(".dt-preview-value");
  if (valueEl) valueEl.textContent = `${Math.round(hpPercent)}%`;

  const previewThumb = fieldset.querySelector(".dt-preview-thumb");
  if (previewThumb) {
    const img = resolveImage(hpPercent, readThresholdsFromDOM(fieldset));
    previewThumb.classList.remove("broken");
    previewThumb.src = img ?? "";
    previewThumb.classList.toggle("empty", !img);
  }

  fieldset.querySelectorAll(".threshold-row").forEach((row) => row.classList.remove("dt-active-row"));
  resolveActiveRow(fieldset, hpPercent)?.classList.add("dt-active-row");
}

/**
 * Re-run the live preview at the slider's current position, e.g. after a
 * threshold row is added, removed, or edited.
 */
function refreshPreview(fieldset) {
  const slider = fieldset.querySelector(".dt-preview-slider");
  updatePreview(fieldset, Number(slider?.value ?? 100));
}

/**
 * Read all threshold rows from the DOM and persist to token flags.
 */
async function saveThresholds(fieldset, tokenDoc) {
  const thresholds = readThresholdsFromDOM(fieldset);
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
