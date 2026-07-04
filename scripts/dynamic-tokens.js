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
 * Read thresholds from a token document's flags. Guards against malformed
 * non-array data (e.g. from a pre-pools schema or manual edits) crashing
 * every downstream .map()/.filter() call.
 */
function getThresholds(tokenDoc) {
  const value = tokenDoc.getFlag(MODULE_ID, "thresholds");
  return Array.isArray(value) ? value : null;
}

/**
 * Read status-effect image overrides from a token document's flags.
 * Array of { status, img }, checked in order — first active match wins.
 */
function getStatusOverrides(tokenDoc) {
  const value = tokenDoc.getFlag(MODULE_ID, "statusOverrides");
  return Array.isArray(value) ? value : null;
}

/**
 * Normalize a threshold entry's images into a [{ img, weight }] pool.
 * Accepts the current `images` array shape as well as the legacy single
 * `img` field saved by versions before random pools existed.
 */
function normalizeThresholdImages(entry) {
  if (!entry) return [];
  if (Array.isArray(entry.images)) {
    return entry.images
      .filter((i) => i?.img)
      .map((i) => ({ img: i.img, weight: i.weight > 0 ? i.weight : 1 }));
  }
  if (entry.img) return [{ img: entry.img, weight: 1 }];
  return [];
}

/**
 * Pick one image from a weighted pool. A single-entry pool always returns
 * that entry — only pools with multiple images roll randomly.
 */
function pickWeightedImage(images) {
  if (!images?.length) return null;
  if (images.length === 1) return images[0].img;
  const total = images.reduce((sum, i) => sum + i.weight, 0);
  let roll = Math.random() * total;
  for (const i of images) {
    if (roll < i.weight) return i.img;
    roll -= i.weight;
  }
  return images[images.length - 1].img;
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
 * Given an HP percentage (0-100) and thresholds, return the matching band as
 * { bandKey, images }. Sorts ascending — the first entry where
 * hpPercent <= threshold is the tightest match.
 */
function resolveImage(hpPercent, thresholds) {
  if (!thresholds?.length) return null;
  const sorted = [...thresholds].sort((a, b) => a.threshold - b.threshold);
  for (const entry of sorted) {
    if (hpPercent <= entry.threshold) {
      const images = normalizeThresholdImages(entry);
      if (!images.length) continue;
      return { bandKey: `threshold:${entry.threshold}`, images };
    }
  }
  return null;
}

/**
 * Check active status effects against the override list, in array order.
 * Returns the same { bandKey, images } shape as resolveImage(), or null.
 */
function resolveStatusOverride(tokenDoc, statusOverrides) {
  if (!statusOverrides?.length) return null;
  const actor = tokenDoc.actor;
  if (!actor) return null;
  for (const entry of statusOverrides) {
    if (!entry.status || !entry.img) continue;
    if (actor.statuses?.has(entry.status)) {
      return { bandKey: `status:${entry.status}`, images: [{ img: entry.img, weight: 1 }] };
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
 * Compute the matching image for a token and swap the texture if needed.
 * Idempotent — safe to call repeatedly. Status-effect overrides are checked
 * first and win outright; otherwise falls back to HP threshold matching.
 *
 * A pooled band (multiple weighted images) only re-rolls when the resolved
 * band itself changes (tracked via the `lastBandKey` flag) and the current
 * texture isn't already a member of that band — otherwise every redundant
 * hook firing (e.g. canvasReady syncing a whole scene) would re-roll the
 * pool and flicker the token's art for no reason.
 */
async function refreshToken(tokenDoc) {
  const thresholds = getThresholds(tokenDoc) ?? [];
  const statusOverrides = getStatusOverrides(tokenDoc) ?? [];
  if (!thresholds.length && !statusOverrides.length) return;

  let resolved = resolveStatusOverride(tokenDoc, statusOverrides);
  if (!resolved) {
    const hpPercent = computeHpPercent(tokenDoc);
    resolved = hpPercent == null ? null : resolveImage(hpPercent, thresholds);
  }
  if (!resolved) return;

  const currentSrc = tokenDoc.texture?.src;
  const lastBandKey = tokenDoc.getFlag(MODULE_ID, "lastBandKey");
  if (lastBandKey === resolved.bandKey && resolved.images.some((i) => i.img === currentSrc)) return;

  const newImg = pickWeightedImage(resolved.images);
  if (!newImg) return;

  const updates = { [`flags.${MODULE_ID}.lastBandKey`]: resolved.bandKey };
  if (newImg !== currentSrc) updates["texture.src"] = newImg;
  await tokenDoc.update(updates);
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
  // The embedded fieldset only edits each threshold's primary image; pool
  // extras (if any, added via the Advanced window) live past index 0.
  const thresholds = (getThresholds(tokenDoc) ?? []).map((entry) => ({
    threshold: entry.threshold,
    img: normalizeThresholdImages(entry)[0]?.img ?? "",
  }));
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

  // "Advanced…" button — opens the ApplicationV2 window for status-effect
  // overrides and per-threshold random image pools
  fieldset.querySelector(".dt-advanced-open")?.addEventListener("click", () => {
    new DynamicTokensAdvancedConfig(tokenDoc).render({ force: true });
  });

  // "Add Threshold" button
  fieldset.querySelector(".dt-add-threshold")?.addEventListener("click", () => {
    const container = fieldset.querySelector(".dynamic-tokens-thresholds");
    const index = container.querySelectorAll(".threshold-row").length;
    const row = document.createElement("div");
    row.classList.add("threshold-row");
    row.dataset.index = index;
    row.innerHTML = `
      <div class="dt-row-fields">
        <div class="dt-row-line">
          <input type="number" class="dt-threshold" aria-label="${game.i18n.localize("DYNAMIC_TOKENS.HpAtMost")}" value="100" min="0" max="100" step="1" placeholder="%" />
          <span>%</span>
        </div>
        <input type="text" class="dt-img" value="" placeholder="${game.i18n.localize("DYNAMIC_TOKENS.ImagePlaceholder")}" />
        <div class="dt-row-line dt-row-buttons">
          <button type="button" class="dt-file-picker" title="${game.i18n.localize("DYNAMIC_TOKENS.BrowseFiles")}">
            <i class="fa-solid fa-file-import"></i>
          </button>
          <button type="button" class="dt-remove" title="${game.i18n.localize("DYNAMIC_TOKENS.RemoveThreshold")}">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
      <img class="dt-thumb empty" src="" alt="" />
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
    // Pools resolve randomly at runtime; the preview shows the primary
    // (first) image as a representative, deterministic stand-in.
    const resolved = resolveImage(hpPercent, readThresholdsFromDOM(fieldset));
    const img = resolved?.images?.[0]?.img ?? null;
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
 *
 * The embedded fieldset only ever edits each threshold's primary image —
 * any extra pool images/weights added via the Advanced window live past
 * index 0 and are preserved here by index. Rows only ever append/remove at
 * the end (no reordering), so index correlation with the saved array holds.
 */
async function saveThresholds(fieldset, tokenDoc) {
  const existing = getThresholds(tokenDoc) ?? [];
  const rows = [...fieldset.querySelectorAll(".threshold-row")];
  const thresholds = rows
    .map((row, i) => {
      const threshold = Number(row.querySelector(".dt-threshold")?.value ?? 100);
      const img = row.querySelector(".dt-img")?.value?.trim() ?? "";
      const existingImages = normalizeThresholdImages(existing[i]);
      const primaryWeight = existingImages[0]?.weight ?? 1;
      const pool = existingImages.slice(1);
      const images = img ? [{ img, weight: primaryWeight }, ...pool] : pool;
      return { threshold, images };
    })
    .filter((t) => t.images.length);
  await tokenDoc.setFlag(MODULE_ID, "thresholds", thresholds);
  // Apply the new configuration immediately so the GM sees the effect
  refreshToken(tokenDoc);
}

/* ---------------------------------------- */
/*  Advanced window — status overrides &     */
/*  per-threshold random image pools         */
/* ---------------------------------------- */

class DynamicTokensAdvancedConfig extends foundry.applications.api.HandlebarsApplicationMixin(
  foundry.applications.api.ApplicationV2
) {
  constructor(tokenDoc, options = {}) {
    super(options);
    this.tokenDoc = tokenDoc;
  }

  static DEFAULT_OPTIONS = {
    id: "dynamic-tokens-advanced-config",
    classes: ["dynamic-tokens-advanced"],
    window: {
      title: "DYNAMIC_TOKENS.AdvancedTitle",
      icon: "fa-solid fa-sliders",
    },
    position: { width: 560, height: "auto" },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/advanced-config.hbs` },
  };

  async _prepareContext(_options) {
    const thresholds = (getThresholds(this.tokenDoc) ?? []).map((entry) => ({
      threshold: entry.threshold,
      images: normalizeThresholdImages(entry),
    }));
    const statusOverrides = getStatusOverrides(this.tokenDoc) ?? [];
    return { thresholds, statusOverrides };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    wireAdvancedListeners(this.element, this.tokenDoc, () => this.render());
  }
}

/**
 * Fill a status-effect <select> with CONFIG.statusEffects and select the
 * given status id, so it stays system-agnostic like the attribute dropdown.
 */
function populateStatusSelect(select, selectedId) {
  if (!select) return;
  select.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = game.i18n.localize("DYNAMIC_TOKENS.None");
  select.appendChild(none);
  for (const status of CONFIG.statusEffects ?? []) {
    if (!status.id) continue;
    const option = document.createElement("option");
    option.value = status.id;
    option.textContent = game.i18n.localize(status.name ?? status.id);
    select.appendChild(option);
  }
  select.value = selectedId ?? "";
}

/**
 * Read all status override rows from the DOM and persist to token flags.
 */
async function saveStatusOverrides(root, tokenDoc) {
  const rows = [...root.querySelectorAll(".dt-status-row")];
  const overrides = rows
    .map((row) => ({
      status: row.querySelector(".dt-status-select")?.value ?? "",
      img: row.querySelector(".dt-img")?.value?.trim() ?? "",
    }))
    .filter((o) => o.status && o.img);
  await tokenDoc.setFlag(MODULE_ID, "statusOverrides", overrides);
  refreshToken(tokenDoc);
}

/**
 * Read all per-threshold pool rows from the DOM and persist to token flags.
 * Threshold values come from the saved flags (this window never adds/removes
 * whole thresholds, only extra images within an existing one), correlated by
 * the same append-only index convention as the embedded fieldset.
 */
async function savePools(root, tokenDoc) {
  const existing = getThresholds(tokenDoc) ?? [];
  const groups = [...root.querySelectorAll(".dt-pool-group")];
  const thresholds = groups
    .map((group, i) => {
      const threshold = existing[i]?.threshold ?? 0;
      const images = [...group.querySelectorAll(".dt-pool-row")]
        .map((row) => ({
          img: row.querySelector(".dt-img")?.value?.trim() ?? "",
          weight: Number(row.querySelector(".dt-weight")?.value) || 1,
        }))
        .filter((i) => i.img);
      return { threshold, images };
    })
    .filter((t) => t.images.length);
  await tokenDoc.setFlag(MODULE_ID, "thresholds", thresholds);
  refreshToken(tokenDoc);
}

/**
 * Wire up a single status override row (status select, image, file picker,
 * remove).
 */
function wireStatusRow(row, root, tokenDoc) {
  populateStatusSelect(row.querySelector(".dt-status-select"), row.dataset.status);
  const imgInput = row.querySelector(".dt-img");
  wireThumbErrorHandling(row.querySelector(".dt-thumb"));

  imgInput?.addEventListener("input", () => updateThumb(row));
  row.addEventListener("change", (e) => {
    if (!e.target.matches(".dt-status-select, .dt-img")) return;
    saveStatusOverrides(root, tokenDoc);
  });
  row.querySelector(".dt-file-picker")?.addEventListener("click", () => {
    const FP = getFilePicker();
    new FP({
      type: "image",
      current: imgInput.value,
      callback: (path) => {
        imgInput.value = path;
        updateThumb(row);
        saveStatusOverrides(root, tokenDoc);
      },
    }).browse();
  });
  row.querySelector(".dt-remove")?.addEventListener("click", () => {
    row.remove();
    saveStatusOverrides(root, tokenDoc);
  });
}

/**
 * Wire up a single pool-image row (image, weight, file picker, remove).
 */
function wirePoolRow(row, root, tokenDoc) {
  const imgInput = row.querySelector(".dt-img");
  wireThumbErrorHandling(row.querySelector(".dt-thumb"));

  imgInput?.addEventListener("input", () => updateThumb(row));
  row.addEventListener("change", (e) => {
    if (!e.target.matches(".dt-img, .dt-weight")) return;
    savePools(root, tokenDoc);
  });
  row.querySelector(".dt-file-picker")?.addEventListener("click", () => {
    const FP = getFilePicker();
    new FP({
      type: "image",
      current: imgInput.value,
      callback: (path) => {
        imgInput.value = path;
        updateThumb(row);
        savePools(root, tokenDoc);
      },
    }).browse();
  });
  row.querySelector(".dt-remove")?.addEventListener("click", () => {
    row.remove();
    savePools(root, tokenDoc);
  });
}

/**
 * Attach all listeners for the Advanced window's content. Add buttons write
 * a placeholder flag entry directly and re-render so the new row comes from
 * the same Handlebars template as the rest, rather than duplicating markup.
 */
function wireAdvancedListeners(root, tokenDoc, rerender) {
  root.querySelectorAll(".dt-status-row").forEach((row) => wireStatusRow(row, root, tokenDoc));

  root.querySelector(".dt-add-status-override")?.addEventListener("click", async () => {
    const overrides = getStatusOverrides(tokenDoc) ?? [];
    await tokenDoc.setFlag(MODULE_ID, "statusOverrides", [...overrides, { status: "", img: "" }]);
    rerender();
  });

  root.querySelectorAll(".dt-pool-group").forEach((group) => {
    group.querySelectorAll(".dt-pool-row").forEach((row) => wirePoolRow(row, root, tokenDoc));

    group.querySelector(".dt-add-pool-image")?.addEventListener("click", async () => {
      const index = Number(group.dataset.index);
      const thresholds = getThresholds(tokenDoc) ?? [];
      const images = normalizeThresholdImages(thresholds[index]);
      images.push({ img: "", weight: 1 });
      thresholds[index] = { threshold: thresholds[index].threshold, images };
      await tokenDoc.setFlag(MODULE_ID, "thresholds", thresholds);
      rerender();
    });
  });
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

// Status conditions (e.g. dead/unconscious/prone) are applied as
// ActiveEffects, not actor data changes, so status-effect overrides need
// their own hooks rather than riding on updateActor.
async function onActorEffectChange(effect, userId) {
  if (game.user.id !== userId) return;
  const actor = effect.parent;
  if (!(actor instanceof Actor)) return;
  for (const tokenDoc of actor.getActiveTokens(false, true)) {
    await refreshToken(tokenDoc);
  }
}

Hooks.on("createActiveEffect", (effect, options, userId) => onActorEffectChange(effect, userId));
Hooks.on("deleteActiveEffect", (effect, options, userId) => onActorEffectChange(effect, userId));
Hooks.on("updateActiveEffect", (effect, changes, options, userId) => onActorEffectChange(effect, userId));
