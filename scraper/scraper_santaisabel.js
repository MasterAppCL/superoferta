/**
 * Scraper - Santa Isabel Chile
 * Usa la API pública de VTEX Search (sin autenticación)
 * 
 * Endpoint base: https://www.santaisabel.cl/api/catalog_system/pub/products/search
 * 
 * Uso:
 *   node scraper_santaisabel.js
 *   node scraper_santaisabel.js --categoria aceites-y-masas
 *   node scraper_santaisabel.js --query "leche"
 * 
 * Requiere: Node.js 18+ (fetch nativo)
 * Instalar dependencias: npm install
 */

import fs from "fs";
import path from "path";

// ──────────────────────────────────────────────
// CONFIGURACIÓN
// ──────────────────────────────────────────────

const CONFIG = {
  // Account VTEX de Santa Isabel
  vtexAccount: "santaisabel",

  // Base URL para la Search API de VTEX (pública, sin auth)
  searchBase: "https://www.santaisabel.cl/api/catalog_system/pub/products/search",

  // Cuántos productos por página (máx VTEX: 50)
  pageSize: 50,

  // Delay entre requests (ms) para no saturar el servidor
  delayMs: 1200,

  // Máximo de páginas por categoría (50 prods x 20 páginas = 1000 prods)
  maxPages: 20,

  // Carpeta de salida
  outputDir: "./data",

  // Categorías de canasta básica y perecibles a scrapear
  // Formato: { nombre, slug_vtex }
  categorias: [
    { nombre: "Aceites y Masas",       slug: "aceites-y-masas" },
    { nombre: "Arroz y Legumbres",     slug: "arroz-y-legumbres" },
    { nombre: "Azúcar y Endulzantes",  slug: "azucar-y-endulzantes" },
    { nombre: "Pastas",                slug: "pastas" },
    { nombre: "Conservas",             slug: "conservas" },
    { nombre: "Leches y Lácteos",      slug: "leches-y-lacteos" },
    { nombre: "Huevos",                slug: "huevos" },
    { nombre: "Pan y Panadería",       slug: "pan-y-panaderia" },
    { nombre: "Carnes",                slug: "carnes" },
    { nombre: "Frutas y Verduras",     slug: "frutas-y-verduras" },
    { nombre: "Detergentes y Limpieza", slug: "detergentes-y-limpieza" },
    { nombre: "Papel Higiénico",       slug: "papel-higienico" },
  ],
};

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg, level = "INFO") {
  const ts = new Date().toISOString().slice(11, 19);
  const prefix = { INFO: "  ", WARN: "⚠ ", ERROR: "✗ ", OK: "✓ " }[level] ?? "  ";
  console.log(`[${ts}] ${prefix}${msg}`);
}

/**
 * Extrae el precio y precio tachado de la respuesta VTEX.
 * VTEX devuelve precios en centavos (dividor 100).
 */
function extraerPrecios(item) {
  const sellers = item.items?.[0]?.sellers ?? [];
  const seller = sellers.find((s) => s.sellerDefault) ?? sellers[0];
  const oferta = seller?.commertialOffer;

  if (!oferta) return { precio: null, precioLista: null, descuento: null };

  const precio = oferta.Price ?? null;
  const precioLista = oferta.ListPrice ?? null;
  const descuento =
    precio && precioLista && precioLista > precio
      ? Math.round(((precioLista - precio) / precioLista) * 100)
      : null;

  return { precio, precioLista, descuento };
}

/**
 * Normaliza el nombre del producto para comparación entre tiendas.
 * Elimina caracteres especiales, unifica unidades, etc.
 */
function normalizarNombre(nombre) {
  return nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quitar tildes
    .replace(/[^a-z0-9\s]/g, " ")    // quitar símbolos
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Mapea un producto VTEX al modelo estándar de SuperOferta.
 */
function mapearProducto(item, categoria) {
  const { precio, precioLista, descuento } = extraerPrecios(item);
  const sku = item.items?.[0];

  return {
    // Identificadores
    productId: item.productId,
    ean: sku?.ean ?? null,
    skuId: sku?.itemId ?? null,

    // Descripción
    nombre: item.productName,
    nombreNormalizado: normalizarNombre(item.productName),
    marca: item.brand ?? null,
    categoria: categoria,
    categoriaOriginal: item.categories?.[0] ?? null,

    // Precios (CLP)
    precio: precio,
    precioLista: precioLista,
    descuentoPct: descuento,
    tieneOferta: descuento !== null && descuento > 0,

    // Disponibilidad
    disponible: sku?.sellers?.[0]?.commertialOffer?.IsAvailable ?? false,

    // Imagen
    imagen: item.items?.[0]?.images?.[0]?.imageUrl ?? null,

    // URL producto
    url: `https://www.santaisabel.cl/${item.linkText}/p`,

    // Metadata
    fuente: "santaisabel.cl",
    scrapedAt: new Date().toISOString(),
  };
}

// ──────────────────────────────────────────────
// SCRAPER VTEX SEARCH API
// ──────────────────────────────────────────────

/**
 * Busca productos por categoría usando la VTEX Search API.
 * URL pattern: /api/catalog_system/pub/products/search/{slug}?_from=0&_to=49
 */
async function scrapearCategoria(cat) {
  const productos = [];
  let from = 0;
  let pagina = 1;

  log(`Scrapeando: ${cat.nombre} (/${cat.slug})`);

  while (pagina <= CONFIG.maxPages) {
    const to = from + CONFIG.pageSize - 1;
    const url = `${CONFIG.searchBase}/${cat.slug}?_from=${from}&_to=${to}`;

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        log(`HTTP ${res.status} en ${cat.slug} pág ${pagina}`, "WARN");
        break;
      }

      const items = await res.json();

      if (!Array.isArray(items) || items.length === 0) {
        log(`  Sin más productos en pág ${pagina}`, "INFO");
        break;
      }

      const mapeados = items.map((item) => mapearProducto(item, cat.nombre));
      productos.push(...mapeados);

      log(`  Pág ${pagina}: +${items.length} prods (total: ${productos.length})`);

      if (items.length < CONFIG.pageSize) break; // última página

      from += CONFIG.pageSize;
      pagina++;
      await sleep(CONFIG.delayMs);
    } catch (err) {
      log(`Error en ${cat.slug} pág ${pagina}: ${err.message}`, "ERROR");
      break;
    }
  }

  return productos;
}

/**
 * Busca productos por texto libre (query).
 * Útil para buscar un producto específico en todas las categorías.
 */
async function buscarProducto(query, maxResultados = 50) {
  const url = `${CONFIG.searchBase}?ft=${encodeURIComponent(query)}&_from=0&_to=${maxResultados - 1}`;

  log(`Buscando: "${query}"`);

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept: "application/json",
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const items = await res.json();
  log(`  Encontrados: ${items.length} productos`, "OK");

  return items.map((item) => mapearProducto(item, "Búsqueda"));
}

// ──────────────────────────────────────────────
// GUARDAR RESULTADOS
// ──────────────────────────────────────────────

function guardarJSON(productos, nombreArchivo) {
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  const filePath = path.join(CONFIG.outputDir, nombreArchivo);
  fs.writeFileSync(filePath, JSON.stringify(productos, null, 2), "utf8");
  log(`Guardado: ${filePath} (${productos.length} productos)`, "OK");
  return filePath;
}

function guardarCSV(productos, nombreArchivo) {
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }

  const headers = [
    "productId", "ean", "nombre", "marca", "categoria",
    "precio", "precioLista", "descuentoPct", "tieneOferta",
    "disponible", "url", "scrapedAt",
  ];

  const filas = productos.map((p) =>
    headers.map((h) => {
      const val = p[h] ?? "";
      return typeof val === "string" && val.includes(",")
        ? `"${val.replace(/"/g, '""')}"`
        : val;
    }).join(",")
  );

  const csv = [headers.join(","), ...filas].join("\n");
  const filePath = path.join(CONFIG.outputDir, nombreArchivo);
  fs.writeFileSync(filePath, csv, "utf8");
  log(`Guardado CSV: ${filePath}`, "OK");
  return filePath;
}

// ──────────────────────────────────────────────
// ESTADÍSTICAS
// ──────────────────────────────────────────────

function imprimirResumen(productos) {
  const conPrecio = productos.filter((p) => p.precio !== null);
  const conOferta = productos.filter((p) => p.tieneOferta);
  const disponibles = productos.filter((p) => p.disponible);

  const precios = conPrecio.map((p) => p.precio).sort((a, b) => a - b);
  const promedio = precios.length
    ? Math.round(precios.reduce((a, b) => a + b, 0) / precios.length)
    : 0;

  console.log("\n─────────────────────────────────────");
  console.log("  RESUMEN DEL SCRAPING");
  console.log("─────────────────────────────────────");
  console.log(`  Total productos  : ${productos.length}`);
  console.log(`  Con precio       : ${conPrecio.length}`);
  console.log(`  Disponibles      : ${disponibles.length}`);
  console.log(`  En oferta        : ${conOferta.length}`);
  console.log(`  Precio promedio  : $${promedio.toLocaleString("es-CL")}`);
  console.log(`  Precio mín       : $${(precios[0] ?? 0).toLocaleString("es-CL")}`);
  console.log(`  Precio máx       : $${(precios.at(-1) ?? 0).toLocaleString("es-CL")}`);

  const porCategoria = {};
  for (const p of productos) {
    porCategoria[p.categoria] = (porCategoria[p.categoria] ?? 0) + 1;
  }
  console.log("\n  Por categoría:");
  for (const [cat, cnt] of Object.entries(porCategoria)) {
    console.log(`    ${cat.padEnd(28)} ${cnt}`);
  }
  console.log("─────────────────────────────────────\n");
}

// ──────────────────────────────────────────────
// MAIN
// ──────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const queryIdx = args.indexOf("--query");
  const catIdx = args.indexOf("--categoria");

  console.log("\n════════════════════════════════════");
  console.log("  SuperOferta — Scraper Santa Isabel");
  console.log("════════════════════════════════════\n");

  let todosLosProductos = [];
  const timestamp = new Date().toISOString().slice(0, 10);

  if (queryIdx !== -1 && args[queryIdx + 1]) {
    // Modo búsqueda por texto
    const query = args[queryIdx + 1];
    const productos = await buscarProducto(query);
    todosLosProductos = productos;
  } else if (catIdx !== -1 && args[catIdx + 1]) {
    // Modo una sola categoría
    const slugArg = args[catIdx + 1];
    const cat = CONFIG.categorias.find((c) => c.slug === slugArg) ?? {
      nombre: slugArg,
      slug: slugArg,
    };
    todosLosProductos = await scrapearCategoria(cat);
  } else {
    // Modo completo: todas las categorías
    for (const cat of CONFIG.categorias) {
      const productos = await scrapearCategoria(cat);
      todosLosProductos.push(...productos);
      await sleep(CONFIG.delayMs * 2); // pausa extra entre categorías
    }
  }

  if (todosLosProductos.length === 0) {
    log("No se encontraron productos.", "WARN");
    return;
  }

  // Guardar resultados
  guardarJSON(todosLosProductos, `santaisabel_${timestamp}.json`);
  guardarCSV(todosLosProductos, `santaisabel_${timestamp}.csv`);

  // Resumen estadístico
  imprimirResumen(todosLosProductos);
}

main().catch((err) => {
  log(err.message, "ERROR");
  process.exit(1);
});
