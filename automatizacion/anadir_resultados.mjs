#!/usr/bin/env node
// Fusiona un lote de resultados clasificados en los datos del repositorio y reconstruye todo.
// Uso: node automatizacion/anadir_resultados.mjs lote.json [lote2.json …] [--fecha 2026-10-11] [--canal openrouter]
//
// Formato de cada lote:
//   { "filas": [ {slug, model, org, det, detNote?, assumed, assumedNote?, reaction, tags, quote, extras, coste?, tok?} ],
//     "no_evaluables": [ {slug, motivo, reintentar?} ] }
// Las filas con un slug ya existente sustituyen a la anterior. Un modelo que pasa a tener fila deja de figurar como no evaluable.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ruta = (...p) => path.join(raiz, ...p);
const args = process.argv.slice(2);
const opt = (nombre, def) => { const i = args.indexOf(nombre); return i >= 0 ? args[i + 1] : def; };
const ficheros = args.filter((a, i) => a.endsWith(".json") && args[i - 1] !== "--fecha" && args[i - 1] !== "--canal");
const fecha = opt("--fecha", new Date().toISOString().slice(0, 10));
const canal = opt("--canal", "openrouter");
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

let nuevas = 0, sustituidas = 0, nuevosNoEval = 0;
for (const f of ficheros) {
  const lote = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const r of lote.filas ?? []) {
    const { coste, tok, ...fila } = r;
    const completa = { test: "t01", ...fila, canal, fecha };
    const i = filas.findIndex((x) => x.slug === fila.slug && x.test === completa.test);
    if (i >= 0) { filas[i] = completa; sustituidas++; } else { filas.push(completa); nuevas++; }
    const p = estado.probados.find((x) => x.slug === fila.slug);
    const reg = { slug: fila.slug, fecha, coste_usd: coste ?? null, tokens_salida: tok ?? null };
    if (p) Object.assign(p, reg); else estado.probados.push(reg);
    noeval = noeval.filter((x) => x.slug !== fila.slug);
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
console.log(`Fusionado: ${nuevas} filas nuevas, ${sustituidas} sustituidas, ${nuevosNoEval} no evaluables nuevos.`);
execFileSync("node", [ruta("automatizacion", "construir.mjs")], { stdio: "inherit" });
