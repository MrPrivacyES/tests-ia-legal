#!/usr/bin/env node
// Lista lo que falta por ejecutar en OpenRouter y estima el coste.
// Uso: node automatizacion/listar_nuevos.mjs [--json ruta.json]
//
// Un modelo está completo cuando tiene «ejecuciones_objetivo» ejecuciones (tres). Entran como candidatos:
//   - los modelos creados desde el último barrido que no están probados,
//   - los modelos con menos ejecuciones que el objetivo (se indica cuántas faltan),
//   - los «no evaluables» marcados con reintentar: true (límite de tasa, timeouts).
// Los bloqueados por la cuenta, la región, la edad o el formato (reintentar: false) no se repiten.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const leer = (f, def) => { const p = path.join(raiz, "datos", f); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : def; };
const estado = leer("estado-openrouter.json");
const noeval = leer("test-01-no-evaluables.json", []);
const salida = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
const objetivo = estado.ejecuciones_objetivo ?? 3;

const { data } = await (await fetch("https://openrouter.ai/api/v1/models")).json();
const ids = new Set(data.map((m) => m.id));
const dia = (iso) => Date.parse(iso + "T00:00:00+02:00") / 1000;
// Corte efectivo: el de estado, o tres días antes del último barrido si es posterior (margen por si un modelo se publica entre pasadas).
const corte = Math.max(dia(estado.corte), estado.ultimo_barrido ? dia(estado.ultimo_barrido) - 3 * 86400 : 0);
const hechas = Object.fromEntries(estado.probados.map((p) => [p.slug, p.ejecuciones ?? 1]));
const bloqueados = new Set(noeval.filter((x) => !x.reintentar).map((x) => x.slug));
const reintentos = new Set(noeval.filter((x) => x.reintentar).map((x) => x.slug));

// Criterios de selección. Se aplican siempre igual para que las rondas sean comparables.
function motivoExclusion(m) {
  if (!(m.architecture?.output_modalities ?? []).every((x) => x === "text")) return "salida no textual";
  if (m.id.endsWith(":batch")) return "variante batch (mismo modelo)";
  if (m.id.startsWith("~")) return "alias que apunta a otro modelo";
  const entrada = Number(m.pricing?.prompt), sal = Number(m.pricing?.completion);
  if (!(entrada >= 0) || !(sal >= 0)) return "enrutador sin precio fijo";
  if ((m.context_length ?? 0) < 32000) return "contexto inferior a 32k";
  if (m.id.endsWith(":free") && ids.has(m.id.replace(/:free$/, ""))) return "variante gratuita de un modelo de pago";
  return null;
}

const nuevos = data.filter((m) => !bloqueados.has(m.id) && (hechas[m.id] ?? 0) < objetivo &&
  (m.created >= corte || reintentos.has(m.id) || m.id in hechas)).sort((a, b) => a.created - b.created);
const candidatos = [], excluidos = [];
for (const m of nuevos) {
  const motivo = motivoExclusion(m);
  if (motivo) { excluidos.push({ id: m.id, motivo }); continue; }
  const faltan = objetivo - (hechas[m.id] ?? 0);
  const porEjecucion = estado.tokens_entrada_estimados * m.pricing.prompt + estado.tokens_salida_estimados * m.pricing.completion;
  candidatos.push({ reintento: reintentos.has(m.id), slug: m.id, nombre: m.name, creado: new Date(m.created * 1000).toISOString().slice(0, 10),
    contexto: m.context_length, ejecuciones_hechas: hechas[m.id] ?? 0, ejecuciones_faltan: faltan, coste_estimado_usd: +(porEjecucion * faltan).toFixed(4) });
}

console.log(`Catálogo: ${data.length} modelos · corte efectivo ${new Date(corte * 1000).toISOString().slice(0, 10)} · objetivo ${objetivo} ejecuciones · candidatos: ${candidatos.length} · excluidos: ${excluidos.length}`);
for (const c of candidatos) console.log(`${c.creado}  ${c.slug.padEnd(48)} faltan ${c.ejecuciones_faltan} ${String(c.coste_estimado_usd.toFixed(3)).padStart(7)} $${c.reintento ? "  (reintento)" : c.ejecuciones_hechas ? "  (completar)" : ""}`);
console.log(`Coste total estimado: ${candidatos.reduce((s, c) => s + c.coste_estimado_usd, 0).toFixed(2)} USD`);
const por = {};
for (const e of excluidos) (por[e.motivo] ??= []).push(e.id);
for (const [motivo, lista] of Object.entries(por)) console.log(`Excluidos · ${motivo} (${lista.length}): ${lista.join(", ")}`);
if (salida) fs.writeFileSync(salida, JSON.stringify({ candidatos, excluidos }, null, 2));
