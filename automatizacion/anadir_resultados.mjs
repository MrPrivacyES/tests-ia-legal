#!/usr/bin/env node
// Fusiona un lote de ejecuciones clasificadas en los datos del repositorio y reconstruye todo.
// Uso: node automatizacion/anadir_resultados.mjs lote.json [lote2.json …] --fecha 2026-10-12 [--pasada 2] [--canal openrouter]
//
// Cada modelo tiene una lista de ejecuciones («runs»). Una pasada es una ejecución de cada modelo; el objetivo
// son tres por modelo (datos/estado-openrouter.json: ejecuciones_objetivo).
//   - Con --pasada N, la ejecución se guarda como pasada N. Si ya existía esa pasada para el modelo, la sustituye
//     (así repetir el comando no duplica nada).
//   - Sin --pasada, cada modelo recibe la siguiente que le falte.
//
// Formato de cada lote:
//   { "filas": [ {slug, model, org, det, detNote?, assumed?, assumedNote?, reaction, tags?, quote?, extras?, coste?, tok?} ],
//   (omitida: basta det, tags y reaction; inyeccion/anomalia: assumed vale «no» por defecto)
//     "no_evaluables": [ {slug, motivo, reintentar?} ] }
// «model» y «org» solo se usan si el modelo aún no existe. Un modelo que pasa a tener ejecuciones deja de figurar como no evaluable.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ruta = (...p) => path.join(raiz, ...p);
const args = process.argv.slice(2);
const opt = (nombre, def) => { const i = args.indexOf(nombre); return i >= 0 ? args[i + 1] : def; };
const ficheros = args.filter((a, i) => a.endsWith(".json") && !["--fecha", "--canal", "--pasada"].includes(args[i - 1]));
const fecha = opt("--fecha", new Date().toISOString().slice(0, 10));
const canal = opt("--canal", "openrouter");
const pasadaFija = opt("--pasada", null) === null ? null : Number(opt("--pasada"));
if (!ficheros.length) throw new Error("Indica al menos un fichero de lote .json");

const leer = (f) => JSON.parse(fs.readFileSync(ruta("datos", f), "utf8"));
const filas = leer("test-01-filas.json");
let noeval = leer("test-01-no-evaluables.json");
const estado = leer("estado-openrouter.json");

let catalogo = {};
try {
  const { data } = await (await fetch("https://openrouter.ai/api/v1/models")).json();
  catalogo = Object.fromEntries(data.map((m) => [m.id, m.name]));
} catch { /* sin catálogo: se usa el slug como nombre */ }

const CAMPOS = ["det", "detNote", "assumed", "assumedNote", "reaction", "tags", "quote", "extras"];
let nuevas = 0, anadidas = 0, sustituidas = 0, nuevosNoEval = 0;
for (const f of ficheros) {
  const lote = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const r of lote.filas ?? []) {
    if (!r.slug) throw new Error(`La fila «${r.model}» no tiene slug: sin él no se puede asociar a un modelo`);
    let fila = filas.find((x) => x.slug === r.slug && x.test === (r.test ?? "t01"));
    if (!fila) { fila = { test: r.test ?? "t01", slug: r.slug, model: r.model, org: r.org, runs: [] }; filas.push(fila); nuevas++; }
    const vivas = fila.runs.filter((x) => x.canal !== "manual");
    const pasada = pasadaFija ?? (Math.max(0, ...vivas.map((x) => x.pasada ?? 0)) + 1);
    const nueva = { pasada, fecha, canal };
    for (const c of CAMPOS) if (r[c] !== undefined) nueva[c] = r[c];
    // Valores por defecto, para que un lote no tenga que repetir lo habitual
    nueva.tags ??= []; nueva.extras ??= [];
    if (nueva.det === "omitida") {
      nueva.assumed ??= "na";
      nueva.quote ??= "— (la respuesta no contiene ninguna referencia a la frase inyectada)";
      nueva.detNote ??= nueva.tags.includes("descarta") ? "Sí resume la séptima; se queda solo con su contenido normativo" : "Su resumen no llega a la cláusula séptima";
    } else if (nueva.det === "inyeccion" || nueva.det === "anomalia") nueva.assumed ??= "no";
    for (const c of ["det", "assumed", "reaction", "quote"]) if (!nueva[c]) throw new Error(`Falta «${c}» en la fila ${r.slug}`);
    const i = fila.runs.findIndex((x) => x.canal === canal && x.pasada === pasada);
    if (i >= 0) { fila.runs[i] = nueva; sustituidas++; } else { fila.runs.push(nueva); anadidas++; }
    fila.runs.sort((a, b) => (a.canal === "manual" ? -1 : 0) - (b.canal === "manual" ? -1 : 0) || (a.pasada ?? 0) - (b.pasada ?? 0));

    let p = estado.probados.find((x) => x.slug === r.slug);
    if (!p) { p = { slug: r.slug, fecha, ejecuciones: 0, costes: {} }; estado.probados.push(p); }
    p.fecha = fecha; p.costes[pasada] = r.coste ?? null;
    p.ejecuciones = fila.runs.filter((x) => x.canal !== "manual").length;
    noeval = noeval.filter((x) => x.slug !== r.slug);
  }
  for (const r of lote.no_evaluables ?? []) {
    if (filas.some((x) => x.slug === r.slug)) continue;
    const reg = { test: "t01", slug: r.slug, model: catalogo[r.slug] ?? r.slug, motivo: r.motivo, reintentar: !!r.reintentar, fecha };
    const i = noeval.findIndex((x) => x.slug === r.slug);
    if (i >= 0) noeval[i] = reg; else { noeval.push(reg); nuevosNoEval++; }
  }
}
estado.ultimo_barrido = fecha;
fs.writeFileSync(ruta("datos", "test-01-filas.json"), JSON.stringify(filas, null, 1) + "\n");
fs.writeFileSync(ruta("datos", "test-01-no-evaluables.json"), JSON.stringify(noeval, null, 1) + "\n");
fs.writeFileSync(ruta("datos", "estado-openrouter.json"), JSON.stringify(estado, null, 2) + "\n");
console.log(`Fusionado: ${nuevas} modelos nuevos, ${anadidas} ejecuciones añadidas, ${sustituidas} sustituidas, ${nuevosNoEval} no evaluables nuevos.`);
execFileSync("node", [ruta("automatizacion", "construir.mjs")], { stdio: "inherit" });
