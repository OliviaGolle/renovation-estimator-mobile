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
let customRoomNames = [];
const PROJECT_STORAGE_KEY = "renovation-estimator-project-v1";

const CATEGORY_LABELS = {
  peinture: "Peinture",
  sol: "Sol",
  menuiserie: "Menuiserie",
  electricite: "Électricité",
  outillage: "Outillage",
  equipement: "Équipement",
};

function productCategory(description) {
  if (/Peinture/i.test(description)) return "peinture";
  if (/Sol|isolant|colle|primaire|joint/i.test(description)) return "sol";
  if (/Fenêtre|Porte/i.test(description)) return "menuiserie";
  if (/Interrupteur|Prise/i.test(description)) return "electricite";
  if (/Outillage/i.test(description)) return "outillage";
  return "equipement";
}

function isPlausiblePrice(price) {
  return Number.isFinite(price) && price > 0 && price <= 100000;
}

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
  if (!isPlausiblePrice(price)) {
    throw new Error("Le prix récupéré est absent ou incohérent.");
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

async function addCustomProduct(url, customProducts, selectedSet, opts) {
  const info = await fetchProductInfo(url);
  const product = {
    id: `custom-${customProducts.length}`,
    name: info.name,
    price: info.price,
    url,
    customCategory: opts.customCategory,
  };
  customProducts.push(product);
  if (!opts.multi) selectedSet.clear();
  selectedSet.add(product.id);
  return product;
}

function renderGallery(container, products, selectedSet, onChange, opts = {}) {
  const category = opts.customCategory
    || Object.keys(CATALOG).find((key) => CATALOG[key] === products);
  const galleryOpts = { ...opts, customCategory: category };
  const customProducts = (opts.customProducts || []).filter(
    (product) => product.customCategory === category
  );
  const displayProducts = [...products, ...customProducts];
  container.innerHTML = "";
  const grid = document.createElement("div");
  grid.className = "gallery";
  const checkboxes = [];
  displayProducts.forEach((p) => {
    const card = document.createElement("div");
    card.className = "card";
    const dimsHtml = opts.showDims && p.width ? `<div class="dims">${p.width} x ${p.height} cm</div>` : "";
    const priceSuffix = opts.priceSuffix || "";
    const linkHtml = p.url
      ? `<a class="product-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Voir la fiche produit</a>`
      : "";
    card.innerHTML = `
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="brand">${escapeHtml(p.brand || "")}</div>
      <div class="price">${p.price.toFixed(2)} €${priceSuffix}</div>
      ${dimsHtml}
      ${linkHtml}
      <label class="choose"><input type="checkbox" ${selectedSet.has(p.id) ? "checked" : ""}> Je choisis</label>
    `;
    if (p.customCategory) {
      const editRow = document.createElement("div");
      editRow.className = "custom-product-form";
      const nameInput = document.createElement("input");
      nameInput.value = p.name;
      nameInput.setAttribute("aria-label", "Nom du produit");
      const priceInput = document.createElement("input");
      priceInput.type = "number";
      priceInput.min = "0.01";
      priceInput.step = "0.01";
      priceInput.value = p.price;
      priceInput.setAttribute("aria-label", "Prix du produit");
      editRow.append(nameInput, priceInput);
      card.appendChild(editRow);
      nameInput.addEventListener("change", () => { p.name = nameInput.value.trim() || p.name; onChange(); });
      priceInput.addEventListener("change", () => {
        const price = toFloat(priceInput.value);
        if (!isPlausiblePrice(price)) { priceInput.value = p.price; return; }
        p.price = price;
        onChange();
      });
    }
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

  if (opts.allowCustomUrl !== false) {
    const customForm = document.createElement("div");
    customForm.className = "dims-row";
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.placeholder = "URL d'un produit";
    const addButton = document.createElement("button");
    addButton.textContent = "Ajouter depuis l'URL";
    const status = document.createElement("span");
    customForm.append(urlInput, addButton, status);
    addButton.addEventListener("click", async () => {
      const url = urlInput.value.trim();
      if (!url) return;
      addButton.disabled = true;
      status.textContent = " Récupération...";
      try {
        await addCustomProduct(url, opts.customProducts, selectedSet, galleryOpts);
        renderGallery(container, products, selectedSet, onChange, galleryOpts);
        onChange();
      } catch (error) {
        status.textContent = ` ${error.message}`;
        addButton.disabled = false;
      }
    });
    container.appendChild(customForm);
  }
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
    customProducts: [],
    dimensionInputs: [],
    checkInputs: {},
    extraChecked: {}, extraSelected: {},
  };

  function renderRoomGallery(container, products, selectedSet, onChange, opts = {}) {
    renderGallery(container, products, selectedSet, onChange, {
      ...opts,
      customProducts: state.customProducts,
    });
  }

  function floorArea() { return state.length * state.width; }
  function wallArea() {
    if (!state.height) return 0;
    let gross = 2 * (state.length + state.width) * state.height;
    let openings = 0;
    state.windows.forEach((w) => {
      if (w.selected.size > 0) openings += (w.width / 100) * (w.height / 100);
    });
    state.doors.forEach((d) => {
      if (d.selected.size > 0) openings += (d.width / 100) * (d.height / 100);
    });
    return Math.max(0, gross - openings);
  }

  function wallAreaDetail() {
    const gross = 2 * (state.length + state.width) * state.height;
    const openings = wallOpeningsArea();
    return `${gross.toFixed(2)} m² de murs - ${openings.toFixed(2)} m² d'ouvertures = ${wallArea().toFixed(2)} m²`;
  }

  function wallOpeningsArea() {
    let openings = 0;
    state.windows.forEach((w) => { if (w.selected.size > 0) openings += (w.width / 100) * (w.height / 100); });
    state.doors.forEach((d) => { if (d.selected.size > 0) openings += (d.width / 100) * (d.height / 100); });
    return openings;
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
    state.dimensionInputs.push(input);
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
    if (state.height) {
      areaLabel.textContent += ` | ${wallAreaDetail()}`;
    }
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
    state.checkInputs[label] = input;
    return input;
  }

  makeCheck("Réfection murs", (checked) => {
    state.murs = checked;
    mursSub.classList.toggle("hidden", !checked);
    if (checked) {
      mursSub.innerHTML = `<h4>Peintures murs (moyenne gamme, blanche) - Leroy Merlin</h4>`;
      const holder = document.createElement("div");
      mursSub.appendChild(holder);
      renderRoomGallery(holder, CATALOG.peinture_mur, state.murSelected, updateTotal);
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
      renderRoomGallery(holder, CATALOG.peinture_plafond, state.plafondSelected, updateTotal);
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
        renderRoomGallery(galleryDiv, CATALOG[category], state.solSelected, updateTotal);

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
          renderRoomGallery(primaireDiv, CATALOG.primaire_accrochage, state.primaireSelected, updateTotal);

          const colleTitle = document.createElement("h4");
          colleTitle.style.marginTop = "8px";
          colleTitle.textContent = "Colle carrelage - Leroy Merlin";
          holder.appendChild(colleTitle);
          const colleDiv = document.createElement("div");
          holder.appendChild(colleDiv);
          renderRoomGallery(colleDiv, CATALOG.colle_carrelage, state.colleSelected, updateTotal);

          const jointTitle = document.createElement("h4");
          jointTitle.style.marginTop = "8px";
          jointTitle.textContent = "Joints de carrelage - Leroy Merlin";
          holder.appendChild(jointTitle);
          const jointDiv = document.createElement("div");
          holder.appendChild(jointDiv);
          renderRoomGallery(jointDiv, CATALOG.joint_carrelage, state.jointSelected, updateTotal);
        } else if (state.solType === "parquet") {
          const isolantTitle = document.createElement("h4");
          isolantTitle.style.marginTop = "8px";
          isolantTitle.textContent = "Isolant sous parquet - Leroy Merlin";
          holder.appendChild(isolantTitle);
          const isolantDiv = document.createElement("div");
          holder.appendChild(isolantDiv);
          renderRoomGallery(isolantDiv, CATALOG.isolant_parquet, state.isolantSelected, updateTotal);
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
      renderRoomGallery(holder, CATALOG.interrupteur_legrand, state.interrupteurSelected, updateTotal, { priceSuffix: "/unité" });
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
      renderRoomGallery(holder, CATALOG.prise_legrand, state.priseSelected, updateTotal, { priceSuffix: "/unité" });
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
      renderRoomGallery(g, sorted, instance.selected, updateTotal, { showDims: true, customCategory: "fenetre_alu_noir" });
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
    const instance = { width: 73, height: 204, selected: new Set() };
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
    const widthInput = makeCmInput("Largeur (cm)", (v) => { instance.width = v; });
    const heightInput = makeCmInput("Hauteur (cm)", (v) => { instance.height = v; });
    widthInput.value = instance.width;
    heightInput.value = instance.height;

    const galleryHolder = document.createElement("div");
    block.appendChild(galleryHolder);

    function refreshGallery() {
      galleryHolder.innerHTML = `<h4>Portes milieu de gamme - Leroy Merlin (les plus proches de vos dimensions en premier)</h4>`;
      const g = document.createElement("div");
      galleryHolder.appendChild(g);
      const sorted = closestSort(CATALOG.porte_milieu_gamme, instance.width, instance.height);
      renderRoomGallery(g, sorted, instance.selected, updateTotal, { showDims: true, customCategory: "porte_milieu_gamme" });
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
          renderRoomGallery(holder, CATALOG[category], state.extraSelected[category], updateTotal, { customCategory: category });
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
  const categoryLabel = document.createElement("div");
  categoryLabel.className = "category-subtotals";
  const warningLabel = document.createElement("div");
  warningLabel.className = "validation-warning";

  function updateTotal() {
    totalLabel.textContent = `Total pièce : ${getTotal().toFixed(2)} €`;
    categoryLabel.replaceChildren(...Object.entries(getCategoryTotals()).map(([category, total]) => {
      const item = document.createElement("span");
      item.textContent = `${CATEGORY_LABELS[category] || category} : ${total.toFixed(2)} €`;
      return item;
    }));
    warningLabel.textContent = getValidationWarnings().join(" ");
    updateGrandTotal();
    saveProject();
  }

  function getCategoryTotals() {
    return getLineItems().reduce((totals, item) => {
      const category = productCategory(item.description);
      totals[category] = (totals[category] || 0) + item.total;
      return totals;
    }, {});
  }

  function getValidationWarnings() {
    const warnings = [];
    if ((state.length || state.width || state.height) && !(state.length && state.width && state.height)) {
      warnings.push("Dimensions de pièce incomplètes.");
    }
    if (state.murs && !state.murSelected.size) warnings.push("Aucune peinture murale sélectionnée.");
    if (state.plafond && !state.plafondSelected.size) warnings.push("Aucune peinture de plafond sélectionnée.");
    if (state.sol && !state.solSelected.size) warnings.push("Aucun revêtement de sol sélectionné.");
    if (state.fenetre && state.windows.some((w) => !w.width || !w.height || !w.selected.size)) warnings.push("Une fenêtre est incomplète ou sans produit.");
    if (state.porte && state.doors.some((d) => !d.width || !d.height || !d.selected.size)) warnings.push("Une porte est incomplète ou sans produit.");
    return warnings;
  }

  function refresh() {
    [state.length, state.width, state.height].forEach((value, index) => {
      if (state.dimensionInputs[index]) state.dimensionInputs[index].value = value || "";
    });
    ["Réfection murs", "Réfection plafond", "Sol", "Fenêtre", "Porte"].forEach((label) => {
      const input = state.checkInputs[label];
      const value = { "Réfection murs": state.murs, "Réfection plafond": state.plafond, Sol: state.sol, Fenêtre: state.fenetre, Porte: state.porte }[label];
      if (input && input.checked !== value) {
        input.checked = value;
        input.dispatchEvent(new Event("change"));
      }
    });
    updateArea();
  }

  function productById(category, id) {
    return (CATALOG[category] || []).find((p) => p.id === id)
      || state.customProducts.find((p) => p.id === id && p.customCategory === category);
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
  panel.appendChild(categoryLabel);
  panel.appendChild(warningLabel);
  panel.appendChild(totalLabel);

  return { roomName, element: panel, getLineItems, getTotal, getDimensionsSummary, getCategoryTotals, getValidationWarnings, getState: () => state, refresh };
}

function updateGrandTotal() {
  let total = 0;
  dynamicRoomNames.forEach((name) => { total += rooms[name].getTotal(); });
  if (rooms["Outillage"].isIncludedInBudget()) {
    total += rooms["Outillage"].getTotal();
  }
  document.getElementById("grand-total").textContent = `Total général : ${total.toFixed(2)} €`;
  const completedRooms = dynamicRoomNames.filter((name) => {
    const room = rooms[name];
    const state = room.getState();
    return state.length > 0 && state.width > 0 && state.height > 0
      && room.getValidationWarnings().length === 0;
  }).length;
  const progress = dynamicRoomNames.length
    ? Math.round((completedRooms / dynamicRoomNames.length) * 100)
    : 0;
  document.getElementById("project-progress").textContent = `Avancement : ${progress}%`;
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

  const addRoomControls = document.createElement("div");
  addRoomControls.className = "add-room-controls";
  const roomNameInput = document.createElement("input");
  roomNameInput.type = "text";
  roomNameInput.placeholder = "Nom de la pièce";
  roomNameInput.setAttribute("aria-label", "Nom de la pièce à ajouter");

  const addRoomBtn = document.createElement("button");
  addRoomBtn.textContent = "Ajouter une pièce";
  addRoomBtn.addEventListener("click", () => {
    const name = roomNameInput.value.trim();
    if (!name) {
      roomNameInput.focus();
      return;
    }
    if (!addCustomRoom(name)) {
      alert("Une pièce porte déjà ce nom.");
      return;
    }
    roomNameInput.value = "";
  });
  roomNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") addRoomBtn.click();
  });
  addRoomControls.append(roomNameInput, addRoomBtn);
  fieldset.appendChild(addRoomControls);

  return { roomName: "Accueil", element: panel };
}

function regenerateRooms(quantities) {
  const previousRooms = { ...rooms };
  const nextNames = [];
  ROOM_TYPES.forEach((type) => {
    const qty = quantities[type] || 0;
    for (let i = 1; i <= qty; i++) {
      const label = qty > 1 ? `${type} ${i}` : type;
      rooms[label] = previousRooms[label] || createRoom(label, type);
      nextNames.push(label);
    }
  });
  customRoomNames.forEach((name) => {
    rooms[name] = previousRooms[name] || createRoom(name);
    nextNames.push(name);
  });
  dynamicRoomNames.forEach((name) => {
    if (!nextNames.includes(name)) {
      rooms[name].element.remove();
      delete rooms[name];
    }
  });
  dynamicRoomNames = nextNames;

  renderTabsAndPanels();
  showRoom(dynamicRoomNames[0] || "Accueil");
  updateGrandTotal();
  saveProject();
}

function addCustomRoom(name) {
  if (rooms[name]) return false;
  rooms[name] = createRoom(name);
  dynamicRoomNames.push(name);
  customRoomNames.push(name);
  renderTabsAndPanels();
  showRoom(name);
  updateGrandTotal();
  saveProject();
  return true;
}

function projectSnapshot() {
  return {
    quantities: ROOM_TYPES.reduce((result, type) => {
      result[type] = dynamicRoomNames.filter((name) => name === type || name.startsWith(`${type} `)).length;
      return result;
    }, {}),
    customRoomNames: [...customRoomNames],
    rooms: dynamicRoomNames.reduce((result, name) => {
      const state = rooms[name].getState();
      result[name] = {
        length: state.length, width: state.width, height: state.height,
        murs: state.murs, plafond: state.plafond, sol: state.sol,
        fenetre: state.fenetre, porte: state.porte,
        interrupteurs: state.interrupteurs, prises: state.prises,
      };
      return result;
    }, {}),
  };
}

function saveProject(showMessage = false) {
  try {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(projectSnapshot()));
    if (showMessage) alert("Projet enregistré sur cet appareil.");
  } catch (error) {
    if (showMessage) alert(`Enregistrement impossible : ${error.message}`);
  }
}

function loadProject() {
  try {
    const snapshot = JSON.parse(localStorage.getItem(PROJECT_STORAGE_KEY) || "null");
    if (!snapshot) { alert("Aucun projet enregistré."); return; }
    customRoomNames = Array.isArray(snapshot.customRoomNames) ? snapshot.customRoomNames : [];
    regenerateRooms(snapshot.quantities || {});
    Object.entries(snapshot.rooms || {}).forEach(([name, values]) => {
      const state = rooms[name]?.getState();
      if (state) Object.assign(state, values);
    });
    dynamicRoomNames.forEach((name) => rooms[name].refresh?.());
    updateGrandTotal();
    alert("Projet repris.");
  } catch (error) {
    alert(`Reprise impossible : ${error.message}`);
  }
}

function createToolsRoom(roomName) {
  const panel = document.createElement("div");
  panel.className = "room-panel";
  panel.dataset.room = roomName;

  const selected = new Set();
  const customItems = []; // { name, price, url, selected: boolean, row }
  let includeInBudget = true;

  const fieldset = document.createElement("fieldset");
  fieldset.className = "section";
  fieldset.innerHTML = `
    <legend>Outillage / kits de pose - Leroy Merlin</legend>
    <p class="area-label">Ces achats sont mutualisés pour l'ensemble du projet (pas liés à une pièce en particulier).</p>
  `;
  const galleryHolder = document.createElement("div");
  fieldset.appendChild(galleryHolder);
  renderGallery(galleryHolder, CATALOG.outillage, selected, updateTotal, { multi: true, allowCustomUrl: false });

  const budgetCheckbox = document.createElement("input");
  budgetCheckbox.type = "checkbox";
  budgetCheckbox.checked = true;
  const budgetLabel = document.createElement("label");
  budgetLabel.append(budgetCheckbox, " Inclure l'outillage dans le budget final");
  budgetCheckbox.addEventListener("change", () => {
    includeInBudget = budgetCheckbox.checked;
    updateTotal();
  });
  fieldset.appendChild(budgetLabel);

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
      selected.clear();
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

  return {
    roomName,
    element: panel,
    getLineItems,
    getTotal,
    getDimensionsSummary,
    isIncludedInBudget: () => includeInBudget,
  };
}


function generateReport() {
  const date = new Date().toLocaleDateString("fr-FR");
  let grandTotal = 0;
  const summaryRows = [];
  const categoryTotals = {};
  const pages = [];

  [...dynamicRoomNames, "Outillage"].forEach((r) => {
    const room = rooms[r];
    const items = room.getLineItems();
    const roomTotal = items.reduce((s, i) => s + i.total, 0);
    const includedInBudget = !room.isIncludedInBudget || room.isIncludedInBudget();
    if (includedInBudget) grandTotal += roomTotal;
    items.forEach((item) => {
      const category = r === "Outillage" ? "outillage" : productCategory(item.description);
      categoryTotals[category] = (categoryTotals[category] || 0) + item.total;
    });
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
        <p class="subtotal">Sous-total ${escapeHtml(r)} : ${roomTotal.toFixed(2)} €${includedInBudget ? "" : " (hors budget final)"}</p>
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
      <h2>Synthèse par catégorie</h2>
      <table>
        <thead><tr><th>Catégorie</th><th>Total</th></tr></thead>
        <tbody>${Object.entries(categoryTotals).map(([category, total]) => `<tr><td>${escapeHtml(CATEGORY_LABELS[category] || category)}</td><td class="num">${total.toFixed(2)} €</td></tr>`).join("")}</tbody>
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
  document.getElementById("save-project-btn").addEventListener("click", () => saveProject(true));
  document.getElementById("load-project-btn").addEventListener("click", loadProject);
  document.getElementById("print-btn").addEventListener("click", () => window.print());
  document.getElementById("back-btn").addEventListener("click", () => {
    document.getElementById("report-view").classList.add("hidden");
    document.getElementById("rooms").classList.remove("hidden");
    document.getElementById("tabs").classList.remove("hidden");
    document.getElementById("app-footer").classList.remove("hidden");
  });
}

init();
