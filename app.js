/* Estimateur de rénovation - version mobile (PWA), logique équivalente à l'appli de bureau. */

// Room types offered on the cover page. Salon is kept in addition to the
// rooms explicitly requested, to preserve the tab that existed before.
const ROOM_TYPES = ["Cuisine", "Chambre", "Salle de bain", "Garage", "Buanderie", "Toilette", "Salon"];

const ROOM_EXTRAS = {
  "Salle de bain": [
    ["toilette", "Toilette"],
    ["douche", "Douche"],
    ["baignoire", "Baignoire"],
    ["mitigeur_douche_bain", "Mitigeur douche/bain"],
    ["meuble_vasque", "Meuble vasque"],
    ["mitigeur_vasque", "Mitigeur vasque"],
    ["seche_serviette", "Sèche-serviette"],
  ],
  "Toilette": [
    ["toilette", "Toilette"],
    ["meuble_lave_main", "Meuble lave-main"],
    ["mitigeur_lave_main", "Mitigeur lave-main"],
  ],
};

let CATALOG = {};
const rooms = {}; // roomName -> room controller
let dynamicRoomNames = []; // currently generated room instance names, in order

function toFloat(v) {
  const n = parseFloat(String(v).replace(",", "."));
  return isNaN(n) || n < 0 ? 0 : n;
}
function toInt(v) {
  const n = parseInt(String(v).replace(",", "."), 10);
  return isNaN(n) || n < 0 ? 0 : n;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
function closestSort(products, w, h) {
  if (!w || !h) return products;
  return [...products].sort((a, b) => {
    const da = Math.abs((a.width || 0) - w) + Math.abs((a.height || 0) - h);
    const db = Math.abs((b.width || 0) - w) + Math.abs((b.height || 0) - h);
    return da - db;
  });
}

// Best-effort scraping of a product page for its name/price (JSON-LD / meta
// tags). Many sites block cross-origin browser requests (CORS) or bot
// traffic entirely, in which case this throws and the caller shows an error.
async function fetchProductInfo(url) {
  const response = await fetch(url, { mode: "cors" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  return parseProductHtml(html);
}

function parseProductHtml(html) {
  let name = null;
  let price = null;

  const jsonLdRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html))) {
    let data;
    try {
      data = JSON.parse(match[1].trim());
    } catch (e) {
      continue;
    }
    const candidates = Array.isArray(data) ? data : [data];
    candidates.forEach((candidate) => {
      if (!candidate || typeof candidate !== "object") return;
      const type = candidate["@type"];
      const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
      if (!isProduct) return;
      if (candidate.name) name = candidate.name;
      let offers = candidate.offers;
      if (Array.isArray(offers)) offers = offers[0];
      if (offers && offers.price !== undefined) {
        const parsed = parseFloat(String(offers.price).replace(",", "."));
        if (!isNaN(parsed)) price = parsed;
      }
    });
  }

  if (!name) {
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (og) name = og[1];
  }
  if (!name) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) name = titleMatch[1];
  }
  if (price === null) {
    const priceMatch = html.match(/<meta[^>]+(?:property|itemprop|name)=["'](?:product:price:amount|price|og:price:amount)["'][^>]+content=["']([\d.,]+)["']/i)
      || html.match(/<meta[^>]+content=["']([\d.,]+)["'][^>]+(?:property|itemprop|name)=["'](?:product:price:amount|price|og:price:amount)["']/i);
    if (priceMatch) {
      const parsed = parseFloat(priceMatch[1].replace(",", "."));
      if (!isNaN(parsed)) price = parsed;
    }
  }

  if (!name || price === null) {
    throw new Error("Nom ou prix introuvable sur cette page.");
  }
  return { name: name.trim(), price };
}

function paintCost(area, product, coats = 2) {
  // Painted surfaces need 2 coats: the effective area to cover is doubled.
  // For pot-based paints, price by the number of whole pots needed for that
  // effective area (a pot covering it costs a single pot, never a fraction).
  const effectiveArea = area * coats;
  if (product.unit === "m2_per_pot") {
    const coverage = product.coverage_m2 || 1;
    const pots = effectiveArea > 0 ? Math.ceil(effectiveArea / coverage) : 0;
    return { total: pots * product.price, pots, effectiveArea };
  }
  return { total: effectiveArea * product.price, pots: null, effectiveArea };
}

function renderGallery(container, products, selectedSet, onChange, opts = {}) {
  container.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "gallery";
  const checkboxes = [];
  products.forEach((p) => {
    const card = document.createElement("div");
    card.className = "card";
    const dimsHtml = opts.showDims && p.width ? `<div class="dims">${p.width} x ${p.height} cm</div>` : "";
    const priceSuffix = opts.priceSuffix || "";
    const linkHtml = p.url
      ? `<a class="product-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Voir la fiche produit</a>`
      : "";
    const photoHtml = p.image
      ? `<img class="photo" src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" loading="lazy" style="background:${p.color || "#ddd"}" onerror="this.onerror=null;this.removeAttribute('src');">`
      : `<div class="photo" style="background:${p.color || "#ddd"}"></div>`;
    card.innerHTML = `
      ${photoHtml}
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="brand">${escapeHtml(p.brand || "")}</div>
      <div class="price">${p.price.toFixed(2)} €${priceSuffix}</div>
      ${dimsHtml}
      ${linkHtml}
      <label class="choose"><input type="checkbox" ${selectedSet.has(p.id) ? "checked" : ""}> Je choisis</label>
    `;
    const checkbox = card.querySelector("input");
    checkboxes.push({ id: p.id, checkbox });
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        if (opts.multi) {
          selectedSet.add(p.id);
        } else {
          // Selecting one product deselects the others (single choice per gallery).
          selectedSet.clear();
          selectedSet.add(p.id);
          checkboxes.forEach((c) => { if (c.id !== p.id) c.checkbox.checked = false; });
        }
      } else {
        selectedSet.delete(p.id);
      }
      onChange();
    });
    grid.appendChild(card);
  });
  container.appendChild(grid);
}

function createRoom(roomName, baseType) {
  const panel = document.createElement("div");
  panel.className = "room-panel";
  panel.dataset.room = roomName;

  const state = {
    length: 0, width: 0, height: 0,
    murs: false, plafond: false, sol: false, fenetre: false, porte: false,
    solType: "carrelage",
    interrupteurs: 0, prises: 0,
    murSelected: new Set(), plafondSelected: new Set(), solSelected: new Set(),
    primaireSelected: new Set(), colleSelected: new Set(), jointSelected: new Set(),
    isolantSelected: new Set(),
    interrupteurSelected: new Set(), priseSelected: new Set(),
    windows: [], doors: [],
    extraChecked: {}, extraSelected: {},
  };

  function floorArea() { return state.length * state.width; }
  function wallArea() {
    if (!state.height) return 0;
    let gross = 2 * (state.length + state.width) * state.height;
    let openings = 0;
    state.windows.forEach((w) => { openings += (w.width / 100) * (w.height / 100); });
    state.doors.forEach((d) => { openings += (d.width / 100) * (d.height / 100); });
    return Math.max(0, gross - openings);
  }

  // ---------- dimensions ----------
  const dimsFieldset = document.createElement("fieldset");
  dimsFieldset.className = "section";
  dimsFieldset.innerHTML = `<legend>Dimensions de la pièce</legend>`;
  const dimsRow = document.createElement("div");
  dimsRow.className = "dims-row";
  const areaLabel = document.createElement("div");
  areaLabel.className = "area-label";
  areaLabel.textContent = "Surface au sol : -";

  function makeDimInput(labelText, onInput) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "0.01";
    label.appendChild(input);
    input.addEventListener("input", () => { onInput(toFloat(input.value)); updateArea(); });
    dimsRow.appendChild(label);
    return input;
  }
  makeDimInput("Longueur (m)", (v) => { state.length = v; });
  makeDimInput("Largeur (m)", (v) => { state.width = v; });
  makeDimInput("Hauteur (m)", (v) => { state.height = v; });
  dimsFieldset.appendChild(dimsRow);
  dimsFieldset.appendChild(areaLabel);

  function updateArea() {
    areaLabel.textContent = (state.length && state.width)
      ? `Surface au sol : ${floorArea().toFixed(2)} m²`
      : "Surface au sol : -";
    updateTotal();
  }

  // ---------- main checkboxes ----------
  const worksFieldset = document.createElement("fieldset");
  worksFieldset.className = "section";
  worksFieldset.innerHTML = `<legend>Travaux</legend>`;
  const checksGrid = document.createElement("div");
  checksGrid.className = "checks-grid";
  worksFieldset.appendChild(checksGrid);

  const mursSub = document.createElement("div");
  mursSub.className = "subsection hidden";
  const plafondSub = document.createElement("div");
  plafondSub.className = "subsection hidden";
  const solSub = document.createElement("div");
  solSub.className = "subsection hidden";
  const fenetreSub = document.createElement("div");
  fenetreSub.className = "subsection hidden";
  const porteSub = document.createElement("div");
  porteSub.className = "subsection hidden";

  function makeCheck(label, onChange) {
    const wrapper = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    wrapper.appendChild(input);
    wrapper.appendChild(document.createTextNode(label));
    input.addEventListener("change", () => onChange(input.checked));
    checksGrid.appendChild(wrapper);
    return input;
  }

  makeCheck("Réfection murs", (checked) => {
    state.murs = checked;
    mursSub.classList.toggle("hidden", !checked);
    if (checked) {
      mursSub.innerHTML = `<h4>Peintures murs (moyenne gamme, blanche) - Leroy Merlin</h4>`;
      const holder = document.createElement("div");
      mursSub.appendChild(holder);
      renderGallery(holder, CATALOG.peinture_mur, state.murSelected, updateTotal);
    } else { state.murSelected.clear(); }
    updateTotal();
  });

  makeCheck("Réfection plafond", (checked) => {
    state.plafond = checked;
    plafondSub.classList.toggle("hidden", !checked);
    if (checked) {
      plafondSub.innerHTML = `<h4>Peintures plafond (moyenne gamme, blanche) - Leroy Merlin</h4>`;
      const holder = document.createElement("div");
      plafondSub.appendChild(holder);
      renderGallery(holder, CATALOG.peinture_plafond, state.plafondSelected, updateTotal);
    } else { state.plafondSelected.clear(); }
    updateTotal();
  });

  makeCheck("Sol", (checked) => {
    state.sol = checked;
    solSub.classList.toggle("hidden", !checked);
    if (checked) {
      solSub.innerHTML = "";
      const choiceRow = document.createElement("div");
      choiceRow.className = "sol-type-choice";
      const holder = document.createElement("div");

      function refreshSolGallery() {
        const category = state.solType === "carrelage" ? "sol_carrelage" : "sol_parquet";
        const label = state.solType === "carrelage" ? "Carrelages" : "Parquets stratifiés";
        holder.innerHTML = `<h4>${label} - Leroy Merlin</h4>`;
        const galleryDiv = document.createElement("div");
        holder.appendChild(galleryDiv);
        state.solSelected.clear();
        renderGallery(galleryDiv, CATALOG[category], state.solSelected, updateTotal);

        state.primaireSelected.clear();
        state.colleSelected.clear();
        state.jointSelected.clear();
        state.isolantSelected.clear();
        if (state.solType === "carrelage") {
          const primaireTitle = document.createElement("h4");
          primaireTitle.style.marginTop = "8px";
          primaireTitle.textContent = "Primaire d'accrochage - Leroy Merlin";
          holder.appendChild(primaireTitle);
          const primaireDiv = document.createElement("div");
          holder.appendChild(primaireDiv);
          renderGallery(primaireDiv, CATALOG.primaire_accrochage, state.primaireSelected, updateTotal);

          const colleTitle = document.createElement("h4");
          colleTitle.style.marginTop = "8px";
          colleTitle.textContent = "Colle carrelage - Leroy Merlin";
          holder.appendChild(colleTitle);
          const colleDiv = document.createElement("div");
          holder.appendChild(colleDiv);
          renderGallery(colleDiv, CATALOG.colle_carrelage, state.colleSelected, updateTotal);

          const jointTitle = document.createElement("h4");
          jointTitle.style.marginTop = "8px";
          jointTitle.textContent = "Joints de carrelage - Leroy Merlin";
          holder.appendChild(jointTitle);
          const jointDiv = document.createElement("div");
          holder.appendChild(jointDiv);
          renderGallery(jointDiv, CATALOG.joint_carrelage, state.jointSelected, updateTotal);
        } else if (state.solType === "parquet") {
          const isolantTitle = document.createElement("h4");
          isolantTitle.style.marginTop = "8px";
          isolantTitle.textContent = "Isolant sous parquet - Leroy Merlin";
          holder.appendChild(isolantTitle);
          const isolantDiv = document.createElement("div");
          holder.appendChild(isolantDiv);
          renderGallery(isolantDiv, CATALOG.isolant_parquet, state.isolantSelected, updateTotal);
        }
        updateTotal();
      }

      ["carrelage", "parquet"].forEach((type) => {
        const lbl = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = `sol-type-${roomName}`;
        radio.checked = state.solType === type;
        radio.addEventListener("change", () => { state.solType = type; refreshSolGallery(); });
        lbl.appendChild(radio);
        lbl.appendChild(document.createTextNode(type === "carrelage" ? "Carrelage" : "Parquet stratifié"));
        choiceRow.appendChild(lbl);
      });

      solSub.appendChild(choiceRow);
      solSub.appendChild(holder);
      refreshSolGallery();
    } else {
      state.solSelected.clear();
      state.primaireSelected.clear();
      state.colleSelected.clear();
      state.jointSelected.clear();
      state.isolantSelected.clear();
    }
    updateTotal();
  });

  makeCheck("Fenêtre", (checked) => {
    state.fenetre = checked;
    fenetreSub.classList.toggle("hidden", !checked);
    if (checked) {
      if (state.windows.length === 0) addWindowInstance();
    } else {
      fenetreSub.innerHTML = "";
      state.windows = [];
    }
    updateTotal();
  });

  makeCheck("Porte", (checked) => {
    state.porte = checked;
    porteSub.classList.toggle("hidden", !checked);
    if (checked) {
      if (state.doors.length === 0) addDoorInstance();
    } else {
      porteSub.innerHTML = "";
      state.doors = [];
    }
    updateTotal();
  });

  worksFieldset.appendChild(mursSub);
  worksFieldset.appendChild(plafondSub);
  worksFieldset.appendChild(solSub);
  worksFieldset.appendChild(fenetreSub);
  worksFieldset.appendChild(porteSub);

  // ---------- counts (interrupteurs / prises) ----------
  const countsRow = document.createElement("div");
  countsRow.className = "counts-grid";
  const interrupteurSub = document.createElement("div");
  interrupteurSub.className = "subsection hidden";
  const priseSub = document.createElement("div");
  priseSub.className = "subsection hidden";

  function makeCountInput(labelText, onInput) {
    const label = document.createElement("label");
    label.textContent = labelText;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    label.appendChild(input);
    input.addEventListener("input", () => onInput(toInt(input.value)));
    countsRow.appendChild(label);
    return input;
  }

  makeCountInput("Interrupteurs (nombre)", (v) => {
    state.interrupteurs = v;
    const show = v > 0;
    interrupteurSub.classList.toggle("hidden", !show);
    if (show && interrupteurSub.childElementCount === 0) {
      interrupteurSub.innerHTML = `<h4>Interrupteurs Legrand (classique) - Leroy Merlin</h4>`;
      const holder = document.createElement("div");
      interrupteurSub.appendChild(holder);
      renderGallery(holder, CATALOG.interrupteur_legrand, state.interrupteurSelected, updateTotal, { priceSuffix: "/unité" });
    } else if (!show) {
      interrupteurSub.innerHTML = "";
      state.interrupteurSelected.clear();
    }
    updateTotal();
  });

  makeCountInput("Prises (nombre)", (v) => {
    state.prises = v;
    const show = v > 0;
    priseSub.classList.toggle("hidden", !show);
    if (show && priseSub.childElementCount === 0) {
      priseSub.innerHTML = `<h4>Prises Legrand (classique) - Leroy Merlin</h4>`;
      const holder = document.createElement("div");
      priseSub.appendChild(holder);
      renderGallery(holder, CATALOG.prise_legrand, state.priseSelected, updateTotal, { priceSuffix: "/unité" });
    } else if (!show) {
      priseSub.innerHTML = "";
      state.priseSelected.clear();
    }
    updateTotal();
  });

  worksFieldset.appendChild(countsRow);
  worksFieldset.appendChild(interrupteurSub);
  worksFieldset.appendChild(priseSub);

  // ---------- windows / doors (repeatable instances) ----------
  function addWindowInstance() {
    const index = state.windows.length + 1;
    const instance = { width: 0, height: 0, selected: new Set() };
    state.windows.push(instance);

    const block = document.createElement("div");
    block.className = "instance-block";
    block.innerHTML = `<h4>Fenêtre #${index}</h4>`;
    const dimsRow2 = document.createElement("div");
    dimsRow2.className = "dims-row";
    block.appendChild(dimsRow2);

    function makeCmInput(labelText, onInput) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.type = "number"; input.min = "0"; input.step = "1";
      label.appendChild(input);
      input.addEventListener("input", () => { onInput(toFloat(input.value)); refreshGallery(); });
      dimsRow2.appendChild(label);
      return input;
    }
    makeCmInput("Longueur (cm)", (v) => { instance.width = v; });
    makeCmInput("Largeur (cm)", (v) => { instance.height = v; });

    const galleryHolder = document.createElement("div");
    block.appendChild(galleryHolder);

    function refreshGallery() {
      galleryHolder.innerHTML = `<h4>Fenêtres aluminium noir - Leroy Merlin (les plus proches de vos dimensions en premier)</h4>`;
      const g = document.createElement("div");
      galleryHolder.appendChild(g);
      const sorted = closestSort(CATALOG.fenetre_alu_noir, instance.width, instance.height);
      renderGallery(g, sorted, instance.selected, updateTotal, { showDims: true });
      updateArea();
    }
    refreshGallery();

    const addMore = document.createElement("label");
    addMore.className = "add-more";
    const addMoreCheck = document.createElement("input");
    addMoreCheck.type = "checkbox";
    addMore.appendChild(addMoreCheck);
    addMore.appendChild(document.createTextNode("Fenêtre (ajouter une fenêtre supplémentaire)"));
    addMoreCheck.addEventListener("change", () => { if (addMoreCheck.checked) addWindowInstance(); });
    block.appendChild(addMore);

    fenetreSub.appendChild(block);
  }

  function addDoorInstance() {
    const index = state.doors.length + 1;
    const instance = { width: 0, height: 0, selected: new Set() };
    state.doors.push(instance);

    const block = document.createElement("div");
    block.className = "instance-block";
    block.innerHTML = `<h4>Porte #${index}</h4>`;
    const dimsRow2 = document.createElement("div");
    dimsRow2.className = "dims-row";
    block.appendChild(dimsRow2);

    function makeCmInput(labelText, onInput) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.type = "number"; input.min = "0"; input.step = "1";
      label.appendChild(input);
      input.addEventListener("input", () => { onInput(toFloat(input.value)); refreshGallery(); });
      dimsRow2.appendChild(label);
      return input;
    }
    makeCmInput("Longueur (cm)", (v) => { instance.width = v; });
    makeCmInput("Largeur (cm)", (v) => { instance.height = v; });

    const galleryHolder = document.createElement("div");
    block.appendChild(galleryHolder);

    function refreshGallery() {
      galleryHolder.innerHTML = `<h4>Portes milieu de gamme - Leroy Merlin (les plus proches de vos dimensions en premier)</h4>`;
      const g = document.createElement("div");
      galleryHolder.appendChild(g);
      const sorted = closestSort(CATALOG.porte_milieu_gamme, instance.width, instance.height);
      renderGallery(g, sorted, instance.selected, updateTotal, { showDims: true });
      updateArea();
    }
    refreshGallery();

    const addMore = document.createElement("label");
    addMore.className = "add-more";
    const addMoreCheck = document.createElement("input");
    addMoreCheck.type = "checkbox";
    addMore.appendChild(addMoreCheck);
    addMore.appendChild(document.createTextNode("Porte (ajouter une porte supplémentaire)"));
    addMoreCheck.addEventListener("change", () => { if (addMoreCheck.checked) addDoorInstance(); });
    block.appendChild(addMore);

    porteSub.appendChild(block);
  }

  // ---------- extras (salle de bain / toilette) ----------
  let extrasFieldset = null;
  const extras = ROOM_EXTRAS[baseType || roomName] || [];
  if (extras.length) {
    extrasFieldset = document.createElement("fieldset");
    extrasFieldset.className = "section";
    extrasFieldset.innerHTML = `<legend>Équipements spécifiques</legend>`;
    const grid = document.createElement("div");
    grid.className = "checks-grid";
    extrasFieldset.appendChild(grid);

    extras.forEach(([category, label]) => {
      state.extraChecked[category] = false;
      state.extraSelected[category] = new Set();
      const sub = document.createElement("div");
      sub.className = "subsection hidden";

      const wrapper = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      wrapper.appendChild(input);
      wrapper.appendChild(document.createTextNode(label));
      input.addEventListener("change", () => {
        state.extraChecked[category] = input.checked;
        sub.classList.toggle("hidden", !input.checked);
        if (input.checked) {
          sub.innerHTML = `<h4>${escapeHtml(label)} - Leroy Merlin</h4>`;
          const holder = document.createElement("div");
          sub.appendChild(holder);
          renderGallery(holder, CATALOG[category], state.extraSelected[category], updateTotal);
        } else {
          sub.innerHTML = "";
          state.extraSelected[category].clear();
        }
        updateTotal();
      });
      grid.appendChild(wrapper);
      extrasFieldset.appendChild(sub);
    });
  }

  // ---------- total ----------
  const totalLabel = document.createElement("div");
  totalLabel.className = "room-total";
  totalLabel.textContent = "Total pièce : 0.00 €";

  function updateTotal() {
    totalLabel.textContent = `Total pièce : ${getTotal().toFixed(2)} €`;
    updateGrandTotal();
  }

  function productById(category, id) {
    return (CATALOG[category] || []).find((p) => p.id === id);
  }

  function getLineItems() {
    const items = [];
    const wArea = wallArea();
    const fArea = floorArea();

    if (state.murs) {
      state.murSelected.forEach((id) => {
        const p = productById("peinture_mur", id);
        if (!p) return;
        const { total, pots, effectiveArea } = paintCost(wArea, p);
        const potsTxt = pots !== null ? ` (${pots} pot${pots > 1 ? "s" : ""})` : "";
        const quantite = `${wArea.toFixed(2)} m² x2 couches = ${effectiveArea.toFixed(2)} m²${potsTxt}`;
        items.push({
          description: `Peinture murs - ${p.name}`,
          quantite,
          prix_unitaire: p.unit === "m2_per_pot" ? `${p.price.toFixed(2)} € / pot (${p.coverage_m2} m²)` : `${p.price.toFixed(2)} €/m²`,
          total,
        });
      });
    }
    if (state.plafond) {
      state.plafondSelected.forEach((id) => {
        const p = productById("peinture_plafond", id);
        if (!p) return;
        const { total, pots, effectiveArea } = paintCost(fArea, p);
        const potsTxt = pots !== null ? ` (${pots} pot${pots > 1 ? "s" : ""})` : "";
        const quantite = `${fArea.toFixed(2)} m² x2 couches = ${effectiveArea.toFixed(2)} m²${potsTxt}`;
        items.push({
          description: `Peinture plafond - ${p.name}`,
          quantite,
          prix_unitaire: p.unit === "m2_per_pot" ? `${p.price.toFixed(2)} € / pot (${p.coverage_m2} m²)` : `${p.price.toFixed(2)} €/m²`,
          total,
        });
      });
    }
    if (state.sol) {
      const category = state.solType === "carrelage" ? "sol_carrelage" : "sol_parquet";
      state.solSelected.forEach((id) => {
        const p = productById(category, id);
        if (!p) return;
        items.push({
          description: `Sol - ${p.name}`,
          quantite: `${fArea.toFixed(2)} m²`,
          prix_unitaire: `${p.price.toFixed(2)} €/m²`,
          total: fArea * p.price,
        });
      });

      if (state.solType === "carrelage") {
        [
          ["primaireSelected", "primaire_accrochage", "Primaire d'accrochage"],
          ["colleSelected", "colle_carrelage", "Colle carrelage"],
          ["jointSelected", "joint_carrelage", "Joint de carrelage"],
        ].forEach(
          ([selectedKey, category2, prefix]) => {
            state[selectedKey].forEach((id) => {
              const p = productById(category2, id);
              if (!p) return;
              const { total, pots, effectiveArea } = paintCost(fArea, p, 1);
              const potsTxt = pots !== null ? ` (${pots} unité${pots > 1 ? "s" : ""})` : "";
              items.push({
                description: `${prefix} - ${p.name}`,
                quantite: `${effectiveArea.toFixed(2)} m²${potsTxt}`,
                prix_unitaire: p.unit === "m2_per_pot" ? `${p.price.toFixed(2)} € / pot (${p.coverage_m2} m²)` : `${p.price.toFixed(2)} €/m²`,
                total,
              });
            });
          }
        );
      } else if (state.solType === "parquet") {
        state.isolantSelected.forEach((id) => {
          const p = productById("isolant_parquet", id);
          if (!p) return;
          const { total, pots, effectiveArea } = paintCost(fArea, p, 1);
          const rollsTxt = pots !== null ? ` (${pots} rouleau${pots > 1 ? "x" : ""})` : "";
          items.push({
            description: `Isolant sous parquet - ${p.name}`,
            quantite: `${effectiveArea.toFixed(2)} m²${rollsTxt}`,
            prix_unitaire: p.unit === "m2_per_pot" ? `${p.price.toFixed(2)} € / rouleau (${p.coverage_m2} m²)` : `${p.price.toFixed(2)} €/m²`,
            total,
          });
        });
      }
    }
    state.windows.forEach((inst, i) => {
      inst.selected.forEach((id) => {
        const p = productById("fenetre_alu_noir", id);
        if (!p) return;
        items.push({
          description: `Fenêtre #${i + 1} - ${p.name} (${p.width}x${p.height} cm)`,
          quantite: "1",
          prix_unitaire: `${p.price.toFixed(2)} €`,
          total: p.price,
        });
      });
    });
    state.doors.forEach((inst, i) => {
      inst.selected.forEach((id) => {
        const p = productById("porte_milieu_gamme", id);
        if (!p) return;
        items.push({
          description: `Porte #${i + 1} - ${p.name} (${p.width}x${p.height} cm)`,
          quantite: "1",
          prix_unitaire: `${p.price.toFixed(2)} €`,
          total: p.price,
        });
      });
    });
    if (state.interrupteurs > 0) {
      state.interrupteurSelected.forEach((id) => {
        const p = productById("interrupteur_legrand", id);
        if (!p) return;
        items.push({
          description: `Interrupteur - ${p.name}`,
          quantite: `${state.interrupteurs}`,
          prix_unitaire: `${p.price.toFixed(2)} €/unité`,
          total: state.interrupteurs * p.price,
        });
      });
    }
    if (state.prises > 0) {
      state.priseSelected.forEach((id) => {
        const p = productById("prise_legrand", id);
        if (!p) return;
        items.push({
          description: `Prise - ${p.name}`,
          quantite: `${state.prises}`,
          prix_unitaire: `${p.price.toFixed(2)} €/unité`,
          total: state.prises * p.price,
        });
      });
    }
    extras.forEach(([category, label]) => {
      if (state.extraChecked[category]) {
        state.extraSelected[category].forEach((id) => {
          const p = productById(category, id);
          if (!p) return;
          items.push({
            description: `${label} - ${p.name}`,
            quantite: "1",
            prix_unitaire: `${p.price.toFixed(2)} €`,
            total: p.price,
          });
        });
      }
    });
    return items;
  }

  function getTotal() {
    return getLineItems().reduce((sum, i) => sum + i.total, 0);
  }

  function getDimensionsSummary() {
    if (!(state.length && state.width)) return "Dimensions non renseignées";
    return `${state.length.toFixed(2)} m x ${state.width.toFixed(2)} m x ${state.height.toFixed(2)} m — Surface au sol : ${floorArea().toFixed(2)} m²`;
  }

  panel.appendChild(dimsFieldset);
  panel.appendChild(worksFieldset);
  if (extrasFieldset) panel.appendChild(extrasFieldset);
  panel.appendChild(totalLabel);

  return { roomName, element: panel, getLineItems, getTotal, getDimensionsSummary };
}

function updateGrandTotal() {
  let total = 0;
  dynamicRoomNames.forEach((name) => { total += rooms[name].getTotal(); });
  total += rooms["Outillage"].getTotal();
  document.getElementById("grand-total").textContent = `Total général : ${total.toFixed(2)} €`;
}

function tabOrder() {
  return ["Accueil", ...dynamicRoomNames, "Outillage"];
}

function showRoom(roomName) {
  tabOrder().forEach((name) => {
    rooms[name].element.classList.toggle("active", name === roomName);
    const btn = document.querySelector(`#tabs button[data-room="${CSS.escape(name)}"]`);
    if (btn) btn.classList.toggle("active", name === roomName);
  });
}

function renderTabsAndPanels() {
  const tabsEl = document.getElementById("tabs");
  const roomsEl = document.getElementById("rooms");
  const names = tabOrder();

  tabsEl.replaceChildren(...names.map((name) => {
    const btn = document.createElement("button");
    btn.textContent = name;
    btn.dataset.room = name;
    btn.addEventListener("click", () => showRoom(name));
    return btn;
  }));

  // replaceChildren moves existing nodes (it does not destroy them), so
  // the persistent Accueil/Outillage panels keep their state.
  roomsEl.replaceChildren(...names.map((name) => rooms[name].element));
}

function createCoverRoom() {
  const panel = document.createElement("div");
  panel.className = "room-panel";
  panel.dataset.room = "Accueil";

  panel.innerHTML = `
    <fieldset class="section">
      <legend>Page de garde</legend>
      <p class="area-label">Indiquez le nombre de pièces de chaque type dans votre projet,
      puis appuyez sur "Générer les onglets".</p>
    </fieldset>
  `;
  const fieldset = panel.querySelector("fieldset");
  const countsGrid = document.createElement("div");
  countsGrid.className = "counts-grid";
  fieldset.appendChild(countsGrid);

  const inputs = {};
  ROOM_TYPES.forEach((type) => {
    const label = document.createElement("label");
    label.textContent = type;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.value = "0";
    label.appendChild(input);
    countsGrid.appendChild(label);
    inputs[type] = input;
  });

  const generateBtn = document.createElement("button");
  generateBtn.id = "generate-tabs-btn";
  generateBtn.textContent = "Générer les onglets";
  generateBtn.addEventListener("click", () => {
    const quantities = {};
    ROOM_TYPES.forEach((type) => { quantities[type] = toInt(inputs[type].value); });
    regenerateRooms(quantities);
  });
  fieldset.appendChild(generateBtn);

  return { roomName: "Accueil", element: panel };
}

function regenerateRooms(quantities) {
  dynamicRoomNames.forEach((name) => {
    if (rooms[name]) {
      rooms[name].element.remove();
      delete rooms[name];
    }
  });
  dynamicRoomNames = [];

  ROOM_TYPES.forEach((type) => {
    const qty = quantities[type] || 0;
    for (let i = 1; i <= qty; i++) {
      const label = qty > 1 ? `${type} ${i}` : type;
      rooms[label] = createRoom(label, type);
      dynamicRoomNames.push(label);
    }
  });

  renderTabsAndPanels();
  showRoom(dynamicRoomNames[0] || "Accueil");
  updateGrandTotal();
}

function createToolsRoom(roomName) {
  const panel = document.createElement("div");
  panel.className = "room-panel";
  panel.dataset.room = roomName;

  const selected = new Set();
  const customItems = []; // { name, price, url, selected: boolean, row }

  const fieldset = document.createElement("fieldset");
  fieldset.className = "section";
  fieldset.innerHTML = `
    <legend>Outillage / kits de pose - Leroy Merlin</legend>
    <p class="area-label">Ces achats sont mutualisés pour l'ensemble du projet (pas liés à une pièce en particulier).</p>
  `;
  const galleryHolder = document.createElement("div");
  fieldset.appendChild(galleryHolder);
  renderGallery(galleryHolder, CATALOG.outillage, selected, updateTotal, { multi: true });

  const customFieldset = document.createElement("fieldset");
  customFieldset.className = "section";
  customFieldset.innerHTML = `
    <legend>Ajouter une référence via une URL (leroymerlin.fr ou autre)</legend>
    <p class="area-label">Le nom et le prix sont récupérés automatiquement depuis la page produit.</p>
  `;

  const customForm = document.createElement("div");
  customForm.className = "dims-row";
  customFieldset.appendChild(customForm);

  const urlLabel = document.createElement("label");
  urlLabel.textContent = "URL";
  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.style.width = "260px";
  urlLabel.appendChild(urlInput);
  customForm.appendChild(urlLabel);

  const addBtn = document.createElement("button");
  addBtn.className = "primary-btn";
  addBtn.textContent = "Ajouter la référence";
  customForm.appendChild(addBtn);

  const statusLabel = document.createElement("p");
  statusLabel.className = "area-label";
  customFieldset.appendChild(statusLabel);

  addBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) {
      alert("Merci de coller une URL de produit.");
      return;
    }
    addBtn.disabled = true;
    statusLabel.textContent = "Récupération des informations depuis la page produit...";
    try {
      const info = await fetchProductInfo(url);
      const item = { name: info.name, price: info.price, url, selected: true };
      customItems.push(item);
      renderCustomItem(item);
      urlInput.value = "";
      updateTotal();
    } catch (err) {
      alert(
        "Impossible de récupérer automatiquement le nom et le prix depuis cette page. "
        + "De nombreux sites (dont leroymerlin.fr) bloquent ce type de requête depuis un navigateur "
        + "(restriction CORS) ou depuis un robot. Cette fonctionnalité est plus fiable dans l'application de bureau.\n\n"
        + `Détail : ${err.message}`
      );
    } finally {
      addBtn.disabled = false;
      statusLabel.textContent = "";
    }
  });

  const customListHolder = document.createElement("div");
  customFieldset.appendChild(customListHolder);

  function renderCustomItem(item) {
    const row = document.createElement("div");
    row.className = "instance-block";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "8px";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addEventListener("change", () => { item.selected = checkbox.checked; updateTotal(); });
    row.appendChild(checkbox);

    const label = document.createElement("span");
    label.textContent = `${item.name} — ${item.price.toFixed(2)} €`;
    row.appendChild(label);

    const link = document.createElement("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "Voir le lien";
    link.className = "product-link";
    row.appendChild(link);

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Supprimer";
    removeBtn.addEventListener("click", () => {
      row.remove();
      const idx = customItems.indexOf(item);
      if (idx >= 0) customItems.splice(idx, 1);
      updateTotal();
    });
    row.appendChild(removeBtn);

    customListHolder.appendChild(row);
  }

  const totalLabel = document.createElement("div");
  totalLabel.className = "room-total";
  totalLabel.textContent = "Total pièce : 0.00 €";

  function updateTotal() {
    totalLabel.textContent = `Total pièce : ${getTotal().toFixed(2)} €`;
    updateGrandTotal();
  }

  function getLineItems() {
    const items = CATALOG.outillage
      .filter((p) => selected.has(p.id))
      .map((p) => ({
        description: p.name,
        quantite: "1",
        prix_unitaire: `${p.price.toFixed(2)} €`,
        total: p.price,
        url: p.url,
      }));
    customItems
      .filter((item) => item.selected)
      .forEach((item) => {
        items.push({
          description: item.name,
          quantite: "1",
          prix_unitaire: `${item.price.toFixed(2)} €`,
          total: item.price,
          url: item.url,
        });
      });
    return items;
  }

  function getTotal() {
    return getLineItems().reduce((sum, i) => sum + i.total, 0);
  }

  function getDimensionsSummary() {
    return "Achats mutualisés pour l'ensemble du projet";
  }

  panel.appendChild(fieldset);
  panel.appendChild(customFieldset);
  panel.appendChild(totalLabel);

  return { roomName, element: panel, getLineItems, getTotal, getDimensionsSummary };
}


function generateReport() {
  const date = new Date().toLocaleDateString("fr-FR");
  let grandTotal = 0;
  const summaryRows = [];
  const pages = [];

  [...dynamicRoomNames, "Outillage"].forEach((r) => {
    const room = rooms[r];
    const items = room.getLineItems();
    const roomTotal = items.reduce((s, i) => s + i.total, 0);
    grandTotal += roomTotal;
    summaryRows.push(`<tr><td>${escapeHtml(r)}</td><td class="num">${roomTotal.toFixed(2)} €</td></tr>`);

    const rowsHtml = items.length
      ? items.map((i) => {
        const descriptionHtml = i.url
          ? `${escapeHtml(i.description)} — <a href="${escapeHtml(i.url)}" target="_blank" rel="noopener">voir la fiche produit</a>`
          : escapeHtml(i.description);
        return `
        <tr>
          <td>${descriptionHtml}</td>
          <td>${escapeHtml(String(i.quantite))}</td>
          <td>${escapeHtml(String(i.prix_unitaire))}</td>
          <td class="num">${i.total.toFixed(2)} €</td>
        </tr>`;
      }).join("")
      : `<tr><td colspan="4" class="empty">Aucun élément sélectionné pour cette pièce.</td></tr>`;

    pages.push(`
      <section class="page">
        <h2>${escapeHtml(r)}</h2>
        <p class="dims">${escapeHtml(room.getDimensionsSummary())}</p>
        <table>
          <thead><tr><th>Description</th><th>Quantité / Surface</th><th>Prix unitaire</th><th>Total</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <p class="subtotal">Sous-total ${escapeHtml(r)} : ${roomTotal.toFixed(2)} €</p>
      </section>
    `);
  });

  const html = `
    <section class="page">
      <h1>Devis estimatif de rénovation</h1>
      <p>Date : ${date}</p>
      <table>
        <thead><tr><th>Pièce</th><th>Sous-total</th></tr></thead>
        <tbody>${summaryRows.join("")}</tbody>
      </table>
      <p class="grand-total">TOTAL GÉNÉRAL ESTIMÉ : ${grandTotal.toFixed(2)} €</p>
      <p class="disclaimer">Prix indicatifs basés sur des produits milieu/moyenne gamme de type Leroy Merlin
      (Luxens, Artens, Sensa, LMDESIGN, Sensea, Legrand Dooxie...). À vérifier et ajuster selon les
      tarifs en vigueur en magasin ou sur leroymerlin.fr avant tout engagement.</p>
    </section>
    ${pages.join("")}
  `;

  document.getElementById("report-content").innerHTML = html;
  document.getElementById("report-view").classList.remove("hidden");
  document.getElementById("rooms").classList.add("hidden");
  document.getElementById("tabs").classList.add("hidden");
  document.getElementById("app-footer").classList.add("hidden");
}

async function init() {
  CATALOG = await fetch("data/products.json").then((r) => r.json());
  rooms["Accueil"] = createCoverRoom();
  rooms["Outillage"] = createToolsRoom("Outillage");
  renderTabsAndPanels();
  showRoom("Accueil");
  updateGrandTotal();

  document.getElementById("generate-report-btn").addEventListener("click", generateReport);
  document.getElementById("print-btn").addEventListener("click", () => window.print());
  document.getElementById("back-btn").addEventListener("click", () => {
    document.getElementById("report-view").classList.add("hidden");
    document.getElementById("rooms").classList.remove("hidden");
    document.getElementById("tabs").classList.remove("hidden");
    document.getElementById("app-footer").classList.remove("hidden");
  });
}

init();
