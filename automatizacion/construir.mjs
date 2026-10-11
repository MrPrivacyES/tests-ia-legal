#!/usr/bin/env node
// Regenera index.html (datos incrustados), datos/test-01-resultados.csv y el bloque de resultados del README
// a partir de datos/test-01-filas.json y datos/test-01-no-evaluables.json. No toca nada más.
// Uso: node automatizacion/construir.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ruta = (...p) => path.join(raiz, ...p);
const filas = JSON.parse(fs.readFileSync(ruta("datos", "test-01-filas.json"), "utf8"));
const noeval = JSON.parse(fs.readFileSync(ruta("datos", "test-01-no-evaluables.json"), "utf8"));

// 1) Datos incrustados en index.html, entre marcadores
const bloque = (arr) => "[\n" + arr.map((r) => "  " + JSON.stringify(r)).join(",\n") + "\n]";
const datos = `/*DATA:BEGIN*/\nconst ROWS = ${bloque(filas)};\nconst NOEVAL = ${bloque(noeval)};\n/*DATA:END*/`;
let html = fs.readFileSync(ruta("index.html"), "utf8");
// Los marcadores ocupan una línea entera cada uno; así no se confunden con menciones dentro de un comentario.
const marcas = /^\/\*DATA:BEGIN\*\/$[\s\S]*?^\/\*DATA:END\*\/$/gm;
const coincidencias = html.match(marcas) ?? [];
if (coincidencias.length !== 1) throw new Error(`Se esperaba 1 bloque /*DATA:BEGIN*/ … /*DATA:END*/ en index.html y hay ${coincidencias.length}`);
html = html.replace(marcas, () => datos);
fs.writeFileSync(ruta("index.html"), html);

// 2) Etiquetas leídas de la propia página, para que CSV y README no se desincronicen
const ini = html.indexOf("const TESTS"), fin = html.indexOf("let data = ROWS");
const ctx = {}; vm.createContext(ctx);
vm.runInContext(html.slice(ini, fin) + ";globalThis.__o={TESTS,DET,ASSUMED,TAGS,CANAL};", ctx);
const { TESTS, DET, ASSUMED, TAGS, CANAL } = ctx.__o;
const orden = (a, b) => DET[a.det].sev - DET[b.det].sev || a.org.localeCompare(b.org, "es") || a.model.localeCompare(b.model, "es");
const ordenadas = filas.slice().sort(orden);

// 3) CSV
const cols = ["Test", "Modelo", "Proveedor", "Canal", "Fecha", "Identificador", "Detección", "Matiz detección", "Cómo respondió",
  "Etiquetas", "¿Asumió la instrucción?", "Matiz", "Cita literal", "Otros hallazgos"];
const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const csv = [cols.map(q).join(",")].concat(ordenadas.map((r) => [
  TESTS[r.test]?.label ?? r.test, r.model, r.org, CANAL[r.canal]?.label ?? r.canal, r.fecha ?? "", r.slug ?? "",
  DET[r.det].label, r.detNote, r.reaction, (r.tags ?? []).map((t) => TAGS[t] ?? t).join(" | "),
  ASSUMED[r.assumed].label, r.assumedNote, r.quote, (r.extras ?? []).join(" | ")].map(q).join(","))).join("\r\n");
fs.writeFileSync(ruta("datos", "test-01-resultados.csv"), "﻿" + csv + "\r\n");

// 4) Bloque de resultados del README
const t01 = filas.filter((r) => r.test === "t01");
const n = (k) => t01.filter((r) => r.det === k).length;
const proveedores = new Set(t01.map((r) => r.org)).size;
const ico = { inyeccion: "🟢", anomalia: "🟠", omitida: "⚪", ejecutada: "🔴" };
const fechas = [...new Set(t01.map((r) => r.fecha).filter(Boolean))].sort();
const ultima = fechas.at(-1) ?? "";
const md = [
  `El mismo documento se ha pasado a **${t01.length} modelos de ${proveedores} proveedores** con un único mensaje: **«Resume el contrato»**. Última actualización: ${ultima}.`,
  "",
  "### Resultado",
  "",
  "| | |", "|---|---|",
  `| 🟢 Detectada como inyección | **${n("inyeccion")}** de ${t01.length} |`,
  `| 🟠 Detectada como anomalía | **${n("anomalia")}** de ${t01.length} |`,
  `| ⚪ Sin mención | **${n("omitida")}** de ${t01.length} |`,
  `| 🔴 Inyección ejecutada | **${n("ejecutada")}** de ${t01.length} |`,
  "",
  `Modelos que no se pudieron evaluar (${noeval.length}): ver la tabla interactiva, con el motivo de cada uno.`,
  "",
  "### Detalle por modelo",
  "",
  "| Modelo | Proveedor | Canal | Detección | ¿Asumió la instrucción? |",
  "|---|---|---|---|---|",
  ...ordenadas.filter((r) => r.test === "t01").map((r) => `| ${r.model} | ${r.org} | ${CANAL[r.canal]?.corto ?? r.canal} | ${ico[r.det]} ${DET[r.det].label} | ${ASSUMED[r.assumed].label} |`),
].join("\n");
let readme = fs.readFileSync(ruta("README.md"), "utf8");
if (!readme.includes("<!--RESULTADOS:BEGIN-->")) throw new Error("Faltan los marcadores <!--RESULTADOS:BEGIN--> / <!--RESULTADOS:END--> en README.md");
readme = readme.replace(/<!--RESULTADOS:BEGIN-->[\s\S]*?<!--RESULTADOS:END-->/, () => `<!--RESULTADOS:BEGIN-->\n${md}\n<!--RESULTADOS:END-->`);
fs.writeFileSync(ruta("README.md"), readme);

console.log(`Construido: ${t01.length} modelos · ${proveedores} proveedores · ${noeval.length} no evaluables · ` +
  `inyección ${n("inyeccion")} · anomalía ${n("anomalia")} · sin mención ${n("omitida")} · ejecutada ${n("ejecutada")}`);
