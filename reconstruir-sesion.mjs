#!/usr/bin/env node
/**
 * reconstruir-sesion.mjs
 *
 * Reconstruye, paso a paso, lo que hizo un agente de Antigravity a partir de los registros que la herramienta
 * guarda en disco.
 *
 * Entrada: el nombre del directorio del proyecto (workspace), p. ej. `kata-mars-rover`. El script localiza todas
 * las sesiones cuyo workspace contiene ese nombre y genera, en Markdown o JSON:
 *   - una tabla resumen con la jerarquía padre/hijo (sesiones que lanzaron subagentes),
 *   - la línea temporal de cada sesión, paso a paso, con el texto tal como figura en los registros y el campo
 *     del que se ha extraído,
 *   - una sección de incidencias por sesión (errores, timers cancelados, subagentes inactivos o terminados,
 *     reinicios del servidor, cambios de modelo, mensajes retenidos >= 10 s y pausas > 1 h), cada una con los
 *     tres pasos que la siguieron,
 *   - una sección de validación que contrasta los supuestos del script con el propio volcado,
 *   - el contexto que recibió el modelo según `gen_metadata`: modelos por generación y bloques del prompt.
 * También admite una sesión concreta (--id, --title, --artifact, --prompt, --date), --list y --batch.
 *
 * Fuentes, todas bajo --root (por defecto, el directorio actual; en una instalación normal, ~/.gemini/antigravity).
 * Los registros solo se leen bajo esa raíz y las URIs file:// que aparecen en ellos no se siguen:
 *   conversations/<id>.db                                    trayectoria completa (SQLite, abierta en solo lectura;
 *                                                            cada paso es un blob protobuf)
 *   brain/<id>/.system_generated/logs/transcript_full.jsonl  transcript legible (omite algunos pasos)
 *   brain/<id>/.system_generated/messages/*.json             mensajes entrantes (subagentes, timers, sistema)
 *   brain/<id>/.system_generated/tasks/task-N.log            logs de tareas en segundo plano
 *   brain/<id>/.system_generated/steps/N/output.txt          salida íntegra de comandos (solo se anota su tamaño)
 *   brain/<id>/*                                             artefactos que la sesión mostró al usuario (solo se
 *                                                            listan sus nombres)
 *
 * Sobre "SQLite + protobuf": Antigravity guarda cada sesión en una base de datos SQLite, pero el contenido de cada
 * fila de la tabla `steps` no es texto ni JSON, sino un mensaje serializado con Protocol Buffers (protobuf), el
 * formato binario de Google. Un mensaje protobuf es una lista de campos numerados con su valor; el esquema (.proto)
 * es lo que da nombre y tipo a cada número, y Antigravity no lo publica. Sin él solo se puede recorrer la estructura
 * y reconocer los campos por su contenido: las rutas que usa este script (p. ej. /20/1 = texto del planner) se
 * dedujeron comparando los blobs con el transcript JSONL, que sí es legible, y se recalibran en cada ejecución con
 * los pasos que aparecen en ambas fuentes. La extracción es dirigida: el script lee los campos que necesita, no
 * todo lo que contiene el registro.
 *
 * Cambios de formato. Antigravity puede cambiar en cualquier versión la forma en que registra las sesiones. En los
 * registros con los que se probó el script, a partir de septiembre de 2026 (desde el día 9):
 *   - todos los pasos de herramienta se escriben con el tipo genérico 132 (GENERIC). El nombre de la herramienta
 *     se recupera de la columna `metadata` de la tabla `steps` y se muestra entre paréntesis junto al tipo,
 *     marcado como inferido;
 *   - los bloques que Antigravity inyecta en el prompt (`<planning_mode>` y otros) dejan de aparecer como pasos
 *     EPHEMERAL_MESSAGE y solo quedan en `gen_metadata`. Si una sesión tiene `<planning_mode>` en `gen_metadata`
 *     pero en ningún paso, el informe lo avisa.
 * Si el formato vuelve a cambiar, la sección de validación de cada informe muestra cuáles de los supuestos que
 * comprueba dejan de cumplirse.
 *
 * Sobre `--routes-out`: esta opción no modifica el informe. Escribe aparte un JSON con la lista de rutas protobuf
 * que el script ha consultado durante la ejecución, para poder responder «¿qué campos del registro lee esto?» sin
 * recorrer el código. Se anota cada consulta por ruta, venga de las tablas fijas o de la calibración. No se anotan
 * los recorridos completos del blob: la calibración y la heurística de último recurso (el texto más largo de un
 * paso) examinan todos los campos de texto, no una ruta concreta.
 *
 * Dos precisiones para leer ese fichero:
 *   - Consultada no es lo mismo que encontrada. Si el script pregunta por /10/2/1/2/3/3/1 y ese campo no existe en
 *     las sesiones procesadas, la ruta aparece igualmente en la lista.
 *   - La lista depende de las sesiones procesadas: con --id solo recoge lo consultado para esa sesión; para la
 *     lista completa hace falta --batch (o un filtro que abarque todas).
 *
 * Formato del fichero:
 *   {
 *     "reader":      "reconstruir-sesion.mjs",          // programa que lo escribió
 *     "generatedAt": "2026-09-27T20:56:20Z",            // fecha de generación, en UTC
 *     "routes":      ["/5/1/1", "/20/1", …],            // rutas consultadas, de más a menos frecuente
 *     "requests":    { "/5/1/1": 9371, "/20/1": 4078 }  // número de consultas por ruta
 *   }
 *
 * Requisitos: Node.js >= 22.13 (usa el módulo node:sqlite, incluido en Node; sin dependencias externas).
 *
 * Uso (desde la raíz que contiene brain/ y conversations/, o indicándola con --root):
 *   node reconstruir-sesion.mjs kata-mars-rover
 *   node reconstruir-sesion.mjs kata-mars-rover --merged --out out/kata.md
 *   node reconstruir-sesion.mjs --list
 *   node reconstruir-sesion.mjs --id 1a2b3c4d --full --thinking
 *   node reconstruir-sesion.mjs --batch --out out/sesiones --full
 *   node reconstruir-sesion.mjs --batch --out out/sesiones --full --routes-out out/routes.json
 *   node reconstruir-sesion.mjs --help
 *
 * Códigos de salida: 0 correcto · 1 argumentos o raíz no válidos · 2 ninguna sesión coincide · 3 selección
 * ambigua (afinar el criterio o usar --all) · 4 --batch terminó con algún informe sin generar.
 *
 * Licencia MIT — Copyright (c) 2026 J. Manuel Velasco
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
 * to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions
 * of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

import { parseArgs } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

// Mientras node:sqlite sea experimental, Node emite un ExperimentalWarning en cada ejecución; se silencia
// únicamente ese aviso.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") console.warn(warning);
});
const { DatabaseSync } = await import("node:sqlite");

// ─────────────────────────────────────────────────────────────────────────────
// Opciones
// ─────────────────────────────────────────────────────────────────────────────

// Argumento posicional (opcional): nombre del directorio del proyecto (workspace), p. ej. `kata-mars-rover`.
// Equivale a --workspace. Hay que indicar --list, --batch o al menos un criterio de selección (el posicional o
// --workspace, --id, --title, --artifact, --date, --prompt); si se indican varios, una sesión tiene que cumplirlos
// todos. Las demás opciones son opcionales.
const { values: options, positionals } = parseArgs({
  options: {
    // Raíz que contiene brain/ y conversations/ (normalmente ~/.gemini/antigravity). Opcional; por defecto el
    // directorio actual. Los registros solo se leen bajo ella.
    root: { type: "string", default: process.cwd() },
    // Selección: sesiones cuyo workspace contiene este texto (todas). Opcional; alternativa al posicional.
    workspace: { type: "string" },
    // Selección: una sesión por id completo, prefijo ('84') o patrón con '*' ('84*d2'). Opcional.
    id: { type: "string" },
    // Selección: sesiones cuyo título (el que muestra Antigravity) contiene este texto. Opcional.
    title: { type: "string" },
    // Selección: sesiones con un artefacto en brain/<id>/ cuyo nombre contiene este texto. Opcional.
    artifact: { type: "string" },
    // Selección: sesiones que empiezan o terminan en esta fecha (YYYY-MM-DD, en UTC). Opcional.
    date: { type: "string" },
    // Selección: sesiones cuyo primer USER_REQUEST contiene este texto. Opcional.
    prompt: { type: "string" },
    // Si un filtro devuelve varias sesiones, genera el historial conjunto en vez de fallar por ambigüedad. Opcional; el workspace lo implica.
    all: { type: "boolean", default: false },
    // Historial conjunto en una única tabla cronológica con todos los pasos de todas las sesiones. Opcional; por defecto una tabla por sesión.
    merged: { type: "boolean", default: false },
    // Lista todas las sesiones de la raíz (id, fechas, pasos, formato, workspace, título, artefactos) y termina. Opcional.
    list: { type: "boolean", default: false },
    // Formato de salida: 'md' (Markdown) o 'json' (estructura completa por paso). Opcional; por defecto 'md'.
    format: { type: "string", default: "md" },
    // Longitud máxima del extracto en la columna Contenido. Opcional; por defecto 200 caracteres (mínimo 20).
    "max-chars": { type: "string", default: "200" },
    // Añade la sección "Detalle por paso" con el contenido íntegro, tool_calls, error_details y logs de tareas. Opcional.
    full: { type: "boolean", default: false },
    // Incluye el razonamiento (thinking) del modelo en el detalle y en el JSON. Opcional; requiere --full para verlo en Markdown.
    thinking: { type: "boolean", default: false },
    // Zona horaria de las horas mostradas: 'utc' (la de los logs), 'local' (la de esta máquina) o un desfase '+HH:MM'. Opcional; por defecto 'utc'.
    tz: { type: "string", default: "utc" },
    // Carga las sesiones hijas (INVOKE_SUBAGENT) e intercala sus pasos en la línea temporal del padre. Opcional.
    "include-subagents": { type: "boolean", default: false },
    // Genera un informe por cada sesión de la raíz en el directorio indicado con --out. Opcional; ignora los
    // criterios de selección.
    batch: { type: "boolean", default: false },
    // Escribe en este fichero un JSON con las rutas protobuf que el script ha consultado durante la ejecución
    // (ver "Sobre --routes-out" en la cabecera). No altera el informe. Opcional.
    "routes-out": { type: "string" },
    // Fichero de salida (se crean los directorios). Opcional; por defecto se escribe en la salida estándar.
    out: { type: "string" },
    // Muestra esta ayuda y termina. Opcional.
    help: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const WORKSPACE_FILTER = options.workspace ?? positionals[0] ?? null;
const TIME_ZONE = options.tz;
const MAX_EXCERPT_CHARS = Math.max(
  20,
  parseInt(options["max-chars"], 10) || 200,
);
const INCLUDE_SUBAGENTS = options["include-subagents"];

if (options.help) {
  printHelp();
  process.exit(0);
}

if (!["md", "json"].includes(options.format)) {
  console.error(
    `--format admite 'md' o 'json' (recibido: '${options.format}').`,
  );
  process.exit(1);
}
if (!/^(utc|local|[+-]\d{2}:\d{2})$/.test(TIME_ZONE)) {
  console.error(
    `--tz admite 'utc', 'local' o un desfase '+HH:MM' (recibido: '${TIME_ZONE}').`,
  );
  process.exit(1);
}

const ROOT = resolve(options.root);
if (
  !existsSync(join(ROOT, "brain")) &&
  !existsSync(join(ROOT, "conversations"))
) {
  console.error(`En ${ROOT} no hay brain/ ni conversations/. Indica --root.`);
  process.exit(1);
}

function printHelp() {
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const docBlock = source.slice(
    source.indexOf("/**") + 3,
    source.indexOf("*/"),
  );
  const lines = docBlock
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""));
  const licenseStart = lines.findIndex((line) =>
    line.startsWith("Licencia MIT"),
  );
  console.log(
    lines
      .slice(0, licenseStart === -1 ? undefined : licenseStart)
      .join("\n")
      .trim(),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Protobuf sin esquema: recorrido del wire format y lectura de campos por ruta numérica
// ─────────────────────────────────────────────────────────────────────────────

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const WIRE_VARINT = 0,
  WIRE_FIXED64 = 1,
  WIRE_LENGTH_DELIMITED = 2,
  WIRE_FIXED32 = 5;

function readVarint(bytes, offset) {
  let value = 0n,
    shift = 0n;
  for (;;) {
    if (offset >= bytes.length) throw new RangeError("varint truncado");
    const byte = bytes[offset++];
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if (!(byte & 0x80)) return [value, offset];
    if (shift > 70n) throw new RangeError("varint demasiado largo");
  }
}

function decodeProtoFields(bytes) {
  const fields = [];
  let offset = 0;
  try {
    while (offset < bytes.length) {
      let tag;
      [tag, offset] = readVarint(bytes, offset);
      const field = Number(tag >> 3n),
        wireType = Number(tag & 7n);
      if (wireType === WIRE_VARINT) {
        let value;
        [value, offset] = readVarint(bytes, offset);
        fields.push({ field, value });
      } else if (wireType === WIRE_FIXED64) {
        fields.push({ field, value: bytes.subarray(offset, offset + 8) });
        offset += 8;
      } else if (wireType === WIRE_FIXED32) {
        fields.push({ field, value: bytes.subarray(offset, offset + 4) });
        offset += 4;
      } else if (wireType === WIRE_LENGTH_DELIMITED) {
        let length;
        [length, offset] = readVarint(bytes, offset);
        fields.push({
          field,
          value: bytes.subarray(offset, offset + Number(length)),
        });
        offset += Number(length);
      } else {
        // Tipos 3 y 4 (grupos, obsoletos) o un byte que no es un tag válido: se devuelve lo leído hasta aquí.
        return fields;
      }
    }
  } catch {
    // Blob que no es protobuf o está truncado: se devuelve lo decodificado hasta ese punto.
  }
  return fields;
}

// Cada consulta por ruta queda anotada aquí, con su número de consultas. Es lo que alimenta --routes-out.
const consultedRoutes = new Map();

function protoValues(bytes, path) {
  const key = "/" + path.join("/");
  consultedRoutes.set(key, (consultedRoutes.get(key) ?? 0) + 1);
  let current = [bytes];
  for (const field of path) {
    const next = [];
    for (const candidate of current) {
      if (!(candidate instanceof Uint8Array)) continue;
      for (const entry of decodeProtoFields(candidate))
        if (entry.field === field) next.push(entry.value);
    }
    current = next;
  }
  return current;
}

function protoInt(bytes, path) {
  const value = protoValues(bytes, path).find((v) => typeof v === "bigint");
  return value === undefined ? null : Number(value);
}

function protoText(bytes, path) {
  for (const value of protoValues(bytes, path)) {
    const text = decodeUtf8Text(value);
    if (text !== null) return text;
  }
  return null;
}

function decodeUtf8Text(value) {
  if (!(value instanceof Uint8Array)) return null;
  try {
    const text = utf8Strict.decode(value);
    let printable = 0,
      total = 0;
    for (const ch of text) {
      total++;
      if (
        ch === "\n" ||
        ch === "\t" ||
        ch === "\r" ||
        (ch >= " " && ch !== "\x7f")
      )
        printable++;
    }
    return printable / Math.max(1, total) > 0.97 ? text : null;
  } catch {
    return null;
  }
}

function walkTextFields(bytes, maxDepth, visit, depth = 0, path = []) {
  for (const { field, value } of decodeProtoFields(bytes)) {
    if (!(value instanceof Uint8Array)) continue;
    const fieldPath = [...path, field];
    const text = decodeUtf8Text(value);
    if (text !== null) visit(text, fieldPath);
    if (depth < maxDepth)
      walkTextFields(value, maxDepth, visit, depth + 1, fieldPath);
  }
}

function allTextFields(bytes) {
  const fields = [];
  walkTextFields(bytes, 7, (text, path) => {
    if (text.length >= 20) fields.push({ text, path });
  });
  return fields;
}

function protoTexts(bytes, accept) {
  const texts = [];
  walkTextFields(bytes, 5, (text) => {
    if (accept(text)) texts.push(text);
  });
  return texts;
}

const isIdentifierNoise = (text) =>
  UUID_PATTERN.test(text) ||
  text.startsWith("sessionID") ||
  /^req_vrtx_/.test(text);

function longestTextField(bytes) {
  let best = { text: "", pathKey: "" };
  walkTextFields(bytes, 5, (text, path) => {
    if (text.length > best.text.length && !isIdentifierNoise(text))
      best = { text, pathKey: "/" + path.join("/") };
  });
  return best;
}

const pathKey = (path) => "/" + path.join("/");

// Rutas de campo deducidas comparando los blobs con el transcript JSONL (Antigravity no publica su esquema).
const PROTO = {
  stepCreatedAt: [5, 1, 1],
  stepUpdatedAt: [5, 7, 1],
  stepRequestInfo: [5, 9, 11],
  plannerText: [20, 1],
  plannerToolCalls: [20, 7],
  toolCallId: [1],
  toolCallName: [2],
  toolCallArgs: [3],
  messageRaw: [114, 1],
  messageTitle: [114, 2, 1],
  messageBody: [114, 2, 2],
  messageId: [114, 4, 1],
  messageSender: [114, 4, 3],
  checkpointTitle: [30, 4],
  checkpointSummary: [30, 5],
  mcpToolName: [5, 4, 2],
  mcpToolArgs: [5, 4, 3],
  errorMessage: [2],
  // Rutas dentro de la columna `metadata` de la tabla `steps` (no de `step_payload`). Desde septiembre de 2026
  // Antigravity escribe todos los pasos de herramienta con step_type 132 (GENERIC), pero el nombre de la
  // herramienta sigue aquí, en las mismas rutas que en los registros anteriores, así que sirve para identificar
  // la herramienta en los pasos de cualquier fecha.
  metaToolCallId: [4, 1],
  metaToolName: [4, 2],
  metaToolArgs: [4, 3],
  metaPermission: [34, 4],
};
const CHECKPOINT_STEP_TYPE = 23;

// ─────────────────────────────────────────────────────────────────────────────
// Conocimiento de respaldo: tablas fijas que la calibración confirma o sustituye en cada ejecución
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_STEP_TYPE_NAMES = {
  5: "CODE_ACTION",
  7: "GREP_SEARCH",
  8: "VIEW_FILE",
  9: "LIST_DIRECTORY",
  14: "USER_INPUT",
  15: "PLANNER_RESPONSE",
  17: "ERROR_MESSAGE",
  21: "RUN_COMMAND",
  23: "CHECKPOINT",
  25: "FIND",
  31: "READ_URL_CONTENT",
  33: "SEARCH_WEB",
  38: "MCP_TOOL_CALL",
  90: "EPHEMERAL_MESSAGE",
  98: "CONVERSATION_HISTORY",
  101: "SYSTEM_MESSAGE",
  127: "INVOKE_SUBAGENT",
  132: "GENERIC",
  138: "ASK_QUESTION",
};
const STATUS_NAMES = { 3: "DONE", 7: "ERROR" };

const FALLBACK_TEXT_PATHS = {
  USER_INPUT: [
    [19, 2],
    [19, 3, 1],
    [19, 3, 2, 16, 4],
  ],
  PLANNER_RESPONSE: [[20, 1]],
  CONVERSATION_HISTORY: [[111, 1]],
  EPHEMERAL_MESSAGE: [
    [103, 1],
    [103, 5],
  ],
  VIEW_FILE: [[14, 1]],
  CODE_ACTION: [
    [10, 2, 1, 8],
    [10, 2, 1, 2, 3, 3, 1],
  ],
  GENERIC: [
    [140, 2, 1],
    [148, 4],
  ],
  RUN_COMMAND: [[28, 21, 1]],
  INVOKE_SUBAGENT: [
    [143, 10, 2],
    [31, 2],
  ],
  ERROR_MESSAGE: [
    [24, 3, 9],
    [24, 3, 2],
  ],
  SEARCH_WEB: [[42, 5]],
  READ_URL_CONTENT: [[40, 6]],
  GREP_SEARCH: [
    [13, 4, 4],
    [13, 4, 3],
  ],
  FIND: [[34, 14]],
  LIST_DIRECTORY: [[15, 3, 1]],
  ASK_QUESTION: [
    [56, 22, 1, 2, 2],
    [154, 1, 5],
  ],
};

const COMPOSITE_CONTENT_TYPES = new Set(["LIST_DIRECTORY"]);

const TOOL_RESULT_HEADER = /^Created At: .*\n(?:.*\n)?Completed At: /m;
const TEXT_CONVENTIONS = {
  USER_INPUT: {
    pattern: /<USER_REQUEST>/,
    purpose:
      "envoltorio <USER_REQUEST> (extracto del prompt y filtro --prompt)",
  },
  INVOKE_SUBAGENT: {
    pattern: /"conversationId":\s*"[0-9a-f-]{36}"/,
    purpose:
      'lista de "conversationId" (jerarquía padre/hijo y --include-subagents)',
  },
  SYSTEM_MESSAGE: {
    pattern: /\[Message\] timestamp=\S+ sender=/,
    purpose:
      'cabecera "[Message] timestamp=… sender=…" (hora de llegada de mensajes)',
  },
  CONVERSATION_HISTORY: {
    pattern: /## Conversation [0-9a-f-]{36}: /,
    purpose:
      'líneas "## Conversation <id>: <título>" (títulos de sesiones sin CHECKPOINT)',
  },
  VIEW_FILE: {
    pattern: TOOL_RESULT_HEADER,
    purpose:
      'líneas "Created At:/Completed At:" en resultados de herramienta (columna Fin)',
  },
  RUN_COMMAND: {
    pattern: TOOL_RESULT_HEADER,
    purpose:
      'líneas "Created At:/Completed At:" en resultados de herramienta (columna Fin)',
  },
  CODE_ACTION: {
    pattern: TOOL_RESULT_HEADER,
    purpose:
      'líneas "Created At:/Completed At:" en resultados de herramienta (columna Fin)',
  },
  LIST_DIRECTORY: {
    pattern: TOOL_RESULT_HEADER,
    purpose:
      'líneas "Created At:/Completed At:" en resultados de herramienta (columna Fin)',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Calibración: los pasos visibles (en SQLite y en el JSONL) enseñan al script cómo leer los que solo están en SQLite
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SAMPLES_PER_TYPE = 40;
const MIN_SAMPLE_TEXT_LENGTH = 24;

const calibration = {
  calibratedSessions: new Set(),
  textPathVotesByType: new Map(),
  observedNamesByTypeCode: new Map(),
  sampleCountByType: new Map(),
  createdAtAgreement: { checked: 0, matching: 0 },
  conventionAgreementByType: new Map(),
};

// En --batch cada sesión se calibra por separado, igual que si se ejecutara el script una vez por sesión; sin
// este reseteo, la calibración de una sesión influiría en el informe de la siguiente.
function resetCalibration() {
  calibration.calibratedSessions.clear();
  calibration.textPathVotesByType.clear();
  calibration.observedNamesByTypeCode.clear();
  calibration.sampleCountByType.clear();
  calibration.conventionAgreementByType.clear();
  calibration.createdAtAgreement.checked = 0;
  calibration.createdAtAgreement.matching = 0;
}

function learnFromVisibleSteps(sessionId, dbSteps, jsonlSteps) {
  if (calibration.calibratedSessions.has(sessionId)) return;
  calibration.calibratedSessions.add(sessionId);
  for (const [idx, jsonlStep] of jsonlSteps) {
    const dbStep = dbSteps.get(idx);
    if (!dbStep || !jsonlStep.type) continue;
    const type = jsonlStep.type,
      content = jsonlStep.content || "";
    recordObservedTypeName(dbStep.step_type, type);
    recordCreatedAtAgreement(dbStep.step_payload, jsonlStep.created_at);
    recordConventionAgreement(type, content);
    recordTextPathVotes(type, dbStep.step_payload, content);
  }
}

function recordObservedTypeName(typeCode, typeName) {
  if (typeCode == null) return;
  const names = calibration.observedNamesByTypeCode.get(typeCode) ?? new Set();
  names.add(typeName);
  calibration.observedNamesByTypeCode.set(typeCode, names);
}

function recordCreatedAtAgreement(payload, createdAt) {
  const seconds = protoInt(payload, PROTO.stepCreatedAt);
  if (seconds == null || !createdAt) return;
  calibration.createdAtAgreement.checked++;
  if (epochSecondsToIso(seconds) === createdAt)
    calibration.createdAtAgreement.matching++;
}

function recordConventionAgreement(type, content) {
  const convention = TEXT_CONVENTIONS[type];
  if (!convention || !content) return;
  const agreement = calibration.conventionAgreementByType.get(type) ?? {
    checked: 0,
    matching: 0,
  };
  agreement.checked++;
  if (convention.pattern.test(content)) agreement.matching++;
  calibration.conventionAgreementByType.set(type, agreement);
}

// Votan todas las rutas cuyo texto es exactamente el content (puede repetirse en varios campos); si ninguna,
// la más larga contenida en él, porque el JSONL añade cabeceras ("Created At:") al texto del campo.
function recordTextPathVotes(type, payload, content) {
  const samples = calibration.sampleCountByType.get(type) ?? 0;
  if (
    samples >= MAX_SAMPLES_PER_TYPE ||
    content.length < MIN_SAMPLE_TEXT_LENGTH
  )
    return;
  calibration.sampleCountByType.set(type, samples + 1);
  const textFields = allTextFields(payload);
  let winners = textFields.filter((f) => f.text === content);
  if (!winners.length) {
    let longestContained = null;
    for (const f of textFields) {
      const usable =
        f.text.length >= MIN_SAMPLE_TEXT_LENGTH &&
        content.includes(f.text) &&
        !UUID_PATTERN.test(f.text);
      if (
        usable &&
        (!longestContained || f.text.length > longestContained.text.length)
      )
        longestContained = f;
    }
    if (longestContained) winners = [longestContained];
  }
  const votes = calibration.textPathVotesByType.get(type) ?? new Map();
  for (const winner of winners)
    votes.set(
      winner.path.join("/"),
      (votes.get(winner.path.join("/")) ?? 0) + 1,
    );
  calibration.textPathVotesByType.set(type, votes);
}

function learnFromSessions(sessionIds) {
  for (const sessionId of sessionIds) {
    if (calibration.calibratedSessions.has(sessionId)) continue;
    const { db } = openSessionDb(sessionId);
    const transcriptPath = transcriptPathOf(sessionId);
    if (!db || !transcriptPath) {
      db?.close();
      continue;
    }
    const dbSteps = new Map(
      db
        .prepare("select idx,step_type,step_payload from steps")
        .all()
        .map((row) => [row.idx, row]),
    );
    const jsonlSteps = new Map(
      readJsonLines(transcriptPath).map((step) => [step.step_index, step]),
    );
    db.close();
    learnFromVisibleSteps(sessionId, dbSteps, jsonlSteps);
  }
}

function textPathCandidates(type) {
  const votes = calibration.textPathVotesByType.get(type) ?? new Map();
  const learned = [...votes]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key.split("/").map(Number));
  const fallback = (FALLBACK_TEXT_PATHS[type] ?? []).filter(
    (path) => !learned.some((l) => l.join("/") === path.join("/")),
  );
  return [
    ...learned.map((path) => ({ path, origin: "calibrada" })),
    ...fallback.map((path) => ({ path, origin: "tabla fija" })),
  ];
}

function stepTypeName(typeCode) {
  const observed = calibration.observedNamesByTypeCode.get(typeCode);
  if (observed && observed.size === 1) return [...observed][0];
  return FALLBACK_STEP_TYPE_NAMES[typeCode] ?? `STEP_TYPE_${typeCode}`;
}

function validationRows() {
  const rows = [];
  const row = (check, samples, result, ok) =>
    rows.push({ check, samples, result, ok });

  const created = calibration.createdAtAgreement;
  row(
    "`/5/1/1` del protobuf == `created_at` del JSONL (datación de pasos ocultos)",
    created.checked,
    created.checked === 0
      ? "sin muestras: se asume"
      : created.matching === created.checked
        ? "coincide en todas"
        : `⚠ coincide en ${created.matching}/${created.checked}`,
    created.checked === 0 || created.matching === created.checked,
  );

  const codes = [...calibration.observedNamesByTypeCode.keys()].sort(
    (a, b) => a - b,
  );
  const observed = (code) =>
    [...calibration.observedNamesByTypeCode.get(code)].join("|");
  const conflicts = codes.filter(
    (c) =>
      FALLBACK_STEP_TYPE_NAMES[c] &&
      (calibration.observedNamesByTypeCode.get(c).size > 1 ||
        !calibration.observedNamesByTypeCode
          .get(c)
          .has(FALLBACK_STEP_TYPE_NAMES[c])),
  );
  const novel = codes.filter((c) => !FALLBACK_STEP_TYPE_NAMES[c]);
  row(
    "mapa `step_type` → nombre",
    codes.length,
    `${codes.length - conflicts.length - novel.length} coinciden con la tabla` +
      (novel.length
        ? `, ${novel.length} nuevos (${novel.map((c) => `${c}=${observed(c)}`).join(", ")})`
        : "") +
      (conflicts.length
        ? `, ⚠ ${conflicts.length} en conflicto (${conflicts.map((c) => `${c}: tabla=${FALLBACK_STEP_TYPE_NAMES[c]} observado=${observed(c)}`).join("; ")})`
        : ""),
    conflicts.length === 0,
  );

  const types = new Set([
    ...Object.keys(FALLBACK_TEXT_PATHS),
    ...calibration.sampleCountByType.keys(),
  ]);
  for (const type of [...types].sort()) {
    const label = `ruta del texto de \`${type}\``;
    const samples = calibration.sampleCountByType.get(type) ?? 0;
    const votes = calibration.textPathVotesByType.get(type) ?? new Map();
    const learned = [...votes].sort((a, b) => b[1] - a[1]);
    const fallback = (FALLBACK_TEXT_PATHS[type] ?? []).map((path) =>
      path.join("/"),
    );
    const fewSamples = samples < 3;
    if (COMPOSITE_CONTENT_TYPES.has(type)) {
      row(
        label,
        samples,
        "contenido compuesto (varios campos): sin ruta única; en pasos ocultos se usa la heurística",
        true,
      );
      continue;
    }
    if (samples === 0) {
      row(
        label,
        0,
        fallback.length
          ? `sin muestras: tabla fija /${fallback[0]}`
          : "sin muestras ni tabla fija: heurística",
        true,
      );
      continue;
    }
    if (!learned.length) {
      row(
        label,
        samples,
        `${fewSamples ? "" : "⚠ "}ninguna ruta coincide con el JSONL en ${samples} muestra(s)${fallback.length ? ` (tabla fija /${fallback[0]} no confirmada)` : ""}: heurística`,
        fewSamples,
      );
      continue;
    }
    const [bestPath, bestVotes] = learned[0];
    const confirmedFallback = fallback.find((path) => votes.has(path));
    if (confirmedFallback)
      row(
        label,
        samples,
        `/${confirmedFallback} confirmada (${votes.get(confirmedFallback)}/${samples})${bestPath !== confirmedFallback ? `; también /${bestPath} (${bestVotes}/${samples})` : ""}`,
        true,
      );
    else
      row(
        label,
        samples,
        `/${bestPath} calibrada (${bestVotes}/${samples})${fallback.length ? `; ${fewSamples ? "" : "⚠ "}tabla fija /${fallback[0]} no confirmada${fewSamples ? " (pocas muestras)" : ""}` : ""}`,
        fallback.length === 0 || fewSamples,
      );
  }

  for (const [type, { purpose }] of Object.entries(TEXT_CONVENTIONS)) {
    const agreement = calibration.conventionAgreementByType.get(type);
    const label = `convención en \`${type}\`: ${purpose}`;
    if (!agreement) {
      row(label, 0, "sin muestras", true);
      continue;
    }
    const result =
      agreement.matching === agreement.checked
        ? "se cumple en todas"
        : agreement.matching === 0
          ? "⚠ no se cumple en ninguna"
          : `se cumple en ${agreement.matching}/${agreement.checked}`;
    row(label, agreement.checked, result, agreement.matching > 0);
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades
// ─────────────────────────────────────────────────────────────────────────────

const epochSecondsToIso = (seconds) =>
  seconds == null
    ? null
    : new Date(seconds * 1000).toISOString().replace(/\.000Z$/, "Z");
const toMillis = (iso) => (iso ? new Date(iso).getTime() : NaN);
const listDir = (path) => (existsSync(path) ? readdirSync(path) : []);
const normalizeForSearch = (text) =>
  (text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
const escapeCell = (text) =>
  String(text ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ⏎ ");

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function excerpt(text, maxChars = MAX_EXCERPT_CHARS) {
  const oneLine = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return oneLine.length > maxChars
    ? oneLine.slice(0, maxChars - 1) + "…"
    : oneLine;
}

function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  if (TIME_ZONE === "utc") return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  let offsetMinutes;
  if (TIME_ZONE === "local") offsetMinutes = -date.getTimezoneOffset();
  else {
    const match = /^([+-])(\d{2}):(\d{2})$/.exec(TIME_ZONE);
    if (!match) return date.toISOString();
    offsetMinutes =
      (match[1] === "-" ? -1 : 1) * (60 * Number(match[2]) + Number(match[3]));
  }
  const shifted = new Date(date.getTime() + offsetMinutes * 60000);
  const sign = offsetMinutes < 0 ? "-" : "+",
    absolute = Math.abs(offsetMinutes);
  const hh = String(Math.floor(absolute / 60)).padStart(2, "0"),
    mm = String(absolute % 60).padStart(2, "0");
  return shifted.toISOString().replace(/\.\d{3}Z$/, "") + `${sign}${hh}:${mm}`;
}

const byStartTime = (a, b) => (a.first || "9").localeCompare(b.first || "9");

// ─────────────────────────────────────────────────────────────────────────────
// Índice de sesiones y selección
// ─────────────────────────────────────────────────────────────────────────────

const isWorkspaceUri = (text) =>
  /^file:\/\/\/\S+$/.test(text) && !text.includes("/.gemini/antigravity/");

function readWorkspaces(db) {
  const blob = db.prepare("select data from trajectory_metadata_blob").get();
  return blob ? [...new Set(protoTexts(blob.data, isWorkspaceUri))] : [];
}

function workspacesFromTranscript(jsonlSteps) {
  const uris = new Set();
  for (const step of jsonlSteps) {
    for (const match of (step.content || "").matchAll(
      /file:\/\/\/[^\s"'`)\]>]+/g,
    ))
      if (isWorkspaceUri(match[0])) uris.add(match[0]);
  }
  return [...uris].sort((a, b) => a.length - b.length).slice(0, 3);
}

// `gen_metadata` guarda una fila por generación: el contexto que se envió al modelo en ese turno. Se lee entera,
// no solo para los nombres de modelo, porque desde septiembre de 2026 los bloques que Antigravity inyecta en el
// prompt (`<planning_mode>` y otros) ya no aparecen como pasos de la tabla `steps` y solo quedan aquí: leer solo
// `steps` haría creer que dejaron de inyectarse.
function readContext(db) {
  const rows = db
    .prepare("select idx,data from gen_metadata order by idx")
    .all();
  const models = new Map();
  let largest = null;
  for (const row of rows) {
    const text = Buffer.from(row.data).toString("latin1");
    const seen = new Set();
    for (const name of text.match(/(?:claude|gemini)-[\w.-]+/g) || []) {
      if (!/[-_]vs[-_]|\.(md|txt|json|ts|js|html)$/.test(name)) seen.add(name);
    }
    for (const name of seen) models.set(name, (models.get(name) ?? 0) + 1);
    if (!largest || row.data.length > largest.data.length) largest = row;
  }
  const biggest = largest ? Buffer.from(largest.data).toString("latin1") : "";
  const tags = [
    ...new Set(
      [...biggest.matchAll(/<([a-z][a-z0-9_]{3,40})>/g)].map((m) => m[1]),
    ),
  ].sort();
  const planningInGen = biggest.includes("<planning_mode>");
  const planningInSteps = db
    .prepare(
      "select count(*) c from steps where instr(step_payload, cast('<planning_mode>' as blob))>0",
    )
    .get().c;
  return {
    generations: rows.length,
    models,
    modelNames: [...models.keys()].sort(),
    largestIdx: largest?.idx ?? null,
    largestBytes: largest?.data.length ?? 0,
    tags,
    planningInGen,
    planningInSteps,
  };
}

function indexTitlesFromConversationHistory() {
  const titles = new Map();
  for (const sessionId of listDir(join(ROOT, "brain"))) {
    const transcriptPath = transcriptPathOf(sessionId);
    if (!transcriptPath) continue;
    for (const match of readFileSync(transcriptPath, "utf8").matchAll(
      /## Conversation ([0-9a-f-]{36}): ([^\\"\n]+)/g,
    )) {
      if (!titles.has(match[1])) titles.set(match[1], match[2].trim());
    }
  }
  return titles;
}

// Transcript legible de la sesión: transcript_full.jsonl y, si no existe, transcript.jsonl.
function transcriptPathOf(sessionId) {
  const logsDir = join(ROOT, "brain", sessionId, ".system_generated", "logs");
  return (
    ["transcript_full.jsonl", "transcript.jsonl"]
      .map((name) => join(logsDir, name))
      .find((path) => existsSync(path)) ?? null
  );
}

function openSessionDb(sessionId) {
  const dbPath = join(ROOT, "conversations", `${sessionId}.db`);
  if (!existsSync(dbPath)) {
    const hasProtobufFile = existsSync(
      join(ROOT, "conversations", `${sessionId}.pb`),
    );
    return {
      db: null,
      warning: hasProtobufFile
        ? "conversations/<id>.pb: formato no soportado; se usa solo el transcript"
        : "sin conversations/<id>.db",
    };
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const hasSteps = db
      .prepare(
        "select count(*) c from sqlite_master where type='table' and name='steps'",
      )
      .get().c;
    if (!hasSteps) {
      db.close();
      return {
        db: null,
        warning: "conversations/<id>.db existe pero no tiene tabla steps",
      };
    }
    return { db, warning: null };
  } catch (error) {
    return {
      db: null,
      warning: `no se pudo abrir la SQLite: ${error.message}`,
    };
  }
}

function summarizeSession(sessionId, historyTitles) {
  const transcriptPath = transcriptPathOf(sessionId);
  const jsonlSteps = transcriptPath ? readJsonLines(transcriptPath) : [];
  const { db, warning } = openSessionDb(sessionId);
  let title = null,
    titleSource = null,
    stepCount = null,
    first = null,
    last = null,
    workspaces = [];
  if (db) {
    stepCount = db.prepare("select count(*) c from steps").get().c;
    workspaces = readWorkspaces(db);
    for (const row of db
      .prepare(
        "select step_payload p from steps where step_type=? order by idx",
      )
      .all(CHECKPOINT_STEP_TYPE)) {
      const checkpointTitle = protoText(row.p, PROTO.checkpointTitle);
      if (checkpointTitle) {
        title = checkpointTitle.split("\n")[0].trim();
        titleSource = "CHECKPOINT /30/4";
        break;
      }
    }
    const firstRow = db
      .prepare("select step_payload p from steps order by idx limit 1")
      .get();
    const lastRow = db
      .prepare("select step_payload p from steps order by idx desc limit 1")
      .get();
    first = firstRow
      ? epochSecondsToIso(protoInt(firstRow.p, PROTO.stepCreatedAt))
      : null;
    last = lastRow
      ? epochSecondsToIso(protoInt(lastRow.p, PROTO.stepCreatedAt))
      : null;
    db.close();
  }
  if (!title && historyTitles.has(sessionId)) {
    title = historyTitles.get(sessionId);
    titleSource = "CONVERSATION_HISTORY de otra sesión";
  }
  const firstUserStep = jsonlSteps.find((step) => step.type === "USER_INPUT");
  const promptText = firstUserStep
    ? (
        userRequestOf(firstUserStep.content || "") ??
        firstUserStep.content ??
        ""
      ).trim()
    : "";
  if (!title && promptText) {
    title = promptText.split("\n")[0].slice(0, 100);
    titleSource = "primer USER_REQUEST";
  }
  if (!first && jsonlSteps.length) {
    first = jsonlSteps[0].created_at;
    last = jsonlSteps.at(-1).created_at;
  }
  if (!workspaces.length) workspaces = workspacesFromTranscript(jsonlSteps);
  const artifacts = listDir(join(ROOT, "brain", sessionId)).filter(
    (name) =>
      !name.startsWith(".") &&
      name !== "scratch" &&
      !name.endsWith(".metadata.json"),
  );
  const format = existsSync(join(ROOT, "conversations", `${sessionId}.db`))
    ? ".db"
    : existsSync(join(ROOT, "conversations", `${sessionId}.pb`))
      ? ".pb"
      : "-";
  const workspaceName = workspaces.length
    ? basename(workspaces[0].replace(/\/+$/, ""))
    : null;
  return {
    id: sessionId,
    title,
    titleSource,
    steps: stepCount,
    jsonlSteps: jsonlSteps.length || null,
    first,
    last,
    artifacts,
    format,
    promptText,
    warning,
    workspaces,
    workspaceName,
  };
}

const userRequestOf = (content) =>
  /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content)?.[1];

function listSessionIds() {
  const ids = new Set();
  for (const name of listDir(join(ROOT, "conversations"))) {
    const match = /^([0-9a-f-]{36})\.(db|pb)$/.exec(name);
    if (match) ids.add(match[1]);
  }
  for (const name of listDir(join(ROOT, "brain")))
    if (UUID_PATTERN.test(name)) ids.add(name);
  return [...ids];
}

function matchesIdFilter(sessionId, filter) {
  const wanted = filter.toLowerCase();
  if (UUID_PATTERN.test(wanted)) return sessionId === wanted;
  if (wanted.includes("*")) {
    const pattern = new RegExp(
      "^" +
        wanted
          .split("*")
          .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
    );
    return pattern.test(sessionId);
  }
  return sessionId.startsWith(wanted);
}

function selectSessions() {
  const historyTitles = indexTitlesFromConversationHistory();
  const summaries = listSessionIds()
    .map((id) => summarizeSession(id, historyTitles))
    .sort(byStartTime);
  if (options.list) return { list: summaries };

  let candidates = summaries;
  if (options.id)
    candidates = candidates.filter((s) => matchesIdFilter(s.id, options.id));
  if (options.title)
    candidates = candidates.filter((s) =>
      normalizeForSearch(s.title).includes(normalizeForSearch(options.title)),
    );
  if (options.artifact)
    candidates = candidates.filter((s) =>
      s.artifacts.some((a) =>
        normalizeForSearch(a).includes(normalizeForSearch(options.artifact)),
      ),
    );
  if (options.date)
    candidates = candidates.filter(
      (s) =>
        (s.first || "").startsWith(options.date) ||
        (s.last || "").startsWith(options.date),
    );
  if (options.prompt)
    candidates = candidates.filter((s) =>
      normalizeForSearch(s.promptText).includes(
        normalizeForSearch(options.prompt),
      ),
    );
  if (WORKSPACE_FILTER)
    candidates = candidates.filter((s) =>
      s.workspaces.some((w) =>
        normalizeForSearch(w).includes(normalizeForSearch(WORKSPACE_FILTER)),
      ),
    );

  const hasSelector =
    WORKSPACE_FILTER ||
    options.id ||
    options.title ||
    options.artifact ||
    options.date ||
    options.prompt;
  if (!hasSelector) {
    console.error(
      "Indica el directorio del proyecto (p. ej. kata-mars-rover), o --id / --title / --artifact / --date / --prompt, o --list / --batch",
    );
    process.exit(1);
  }
  if (candidates.length === 0) {
    console.error("Ninguna sesión coincide.");
    process.exit(2);
  }
  if (candidates.length === 1) return { session: candidates[0] };
  if (WORKSPACE_FILTER || options.all) return { multi: candidates };
  console.error(
    `Ambiguo: ${candidates.length} sesiones coinciden. Afina el criterio o añade --all para un historial conjunto:`,
  );
  console.error(renderSessionList(candidates));
  process.exit(3);
}

function renderSessionList(summaries) {
  const lines = [
    "| Sesión | Inicio (UTC) | Pasos DB | Pasos JSONL | Fmt | Workspace | Título (origen) | Artefactos |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const s of summaries) {
    lines.push(
      `| \`${s.id}\` | ${s.first || ""} | ${s.steps ?? ""} | ${s.jsonlSteps ?? ""} | ${s.format} | ${escapeCell(s.workspaceName || "")} | ${escapeCell(s.title || "(sin título)")} ${s.titleSource ? `_(${s.titleSource})_` : ""} | ${s.artifacts.map(escapeCell).join(", ")} |`,
    );
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Reconstrucción de una sesión: fusión de SQLite, JSONL, mensajes, tareas y salidas
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_STEP_TYPES = new Set([
  "SYSTEM_MESSAGE",
  "CONVERSATION_HISTORY",
  "CHECKPOINT",
]);

function readSessionSources(sessionId) {
  const brainDir = join(ROOT, "brain", sessionId, ".system_generated");
  const warnings = [];
  const { db, warning } = openSessionDb(sessionId);
  if (warning) warnings.push(warning);

  const transcriptPath = transcriptPathOf(sessionId);
  if (!transcriptPath)
    warnings.push(
      "sin brain/<id>/.system_generated/logs/transcript_full.jsonl",
    );
  const jsonlSteps = new Map(
    transcriptPath
      ? readJsonLines(transcriptPath).map((step) => [step.step_index, step])
      : [],
  );

  const inboxMessages = new Map();
  for (const name of listDir(join(brainDir, "messages"))) {
    if (
      !name.endsWith(".json") ||
      name === "cursor.json" ||
      name === "read.json"
    )
      continue;
    try {
      const message = JSON.parse(
        readFileSync(join(brainDir, "messages", name), "utf8"),
      );
      if (message && message.id)
        inboxMessages.set(message.id, { ...message, file: `messages/${name}` });
    } catch {
      // Fichero de mensaje ilegible: se ignora.
    }
  }

  const taskLogs = new Map();
  for (const name of listDir(join(brainDir, "tasks"))) {
    const match = /^task-(\d+)\.log$/.exec(name);
    if (match)
      taskLogs.set(
        Number(match[1]),
        readFileSync(join(brainDir, "tasks", name), "utf8"),
      );
  }

  // De la salida íntegra de cada comando solo se anota el tamaño en bytes; el contenido no se lee.
  const commandOutputSizes = new Map();
  for (const name of listDir(join(brainDir, "steps"))) {
    const outputPath = join(brainDir, "steps", name, "output.txt");
    if (/^\d+$/.test(name) && existsSync(outputPath))
      commandOutputSizes.set(Number(name), statSync(outputPath).size);
  }

  const meta = {
    trajectoryId: null,
    models: [],
    workspaces: [],
    context: null,
  };
  const dbSteps = new Map();
  if (db) {
    meta.trajectoryId =
      db.prepare("select trajectory_id t from trajectory_meta").get()?.t ??
      null;
    meta.context = readContext(db);
    meta.models = meta.context.modelNames;
    meta.workspaces = readWorkspaces(db);
    if (meta.context.planningInGen && meta.context.planningInSteps === 0) {
      warnings.push(
        "inyección de contexto no tipada: <planning_mode> aparece en gen_metadata pero en ningún paso de steps; la ausencia de pasos EPHEMERAL_MESSAGE no significa que la inyección haya dejado de producirse",
      );
    }
    for (const row of db
      .prepare(
        "select idx,step_type,status,step_payload,metadata,error_details from steps order by idx",
      )
      .all())
      dbSteps.set(row.idx, row);
    db.close();
  }

  const checkpointTitle =
    [...dbSteps.values()]
      .filter((row) => row.step_type === CHECKPOINT_STEP_TYPE)
      .map((row) => protoText(row.step_payload, PROTO.checkpointTitle))
      .find(Boolean)
      ?.split("\n")[0]
      .trim() ?? null;
  const sources = {
    db: !!db,
    jsonl: transcriptPath ? basename(transcriptPath) : null,
    messages: inboxMessages.size,
    tasks: taskLogs.size,
    outputs: commandOutputSizes.size,
  };
  return {
    dbSteps,
    jsonlSteps,
    inboxMessages,
    taskLogs,
    commandOutputSizes,
    meta,
    warnings,
    checkpointTitle,
    sources,
  };
}

function reconstructSession(sessionId, depth = 0) {
  const src = readSessionSources(sessionId);
  learnFromVisibleSteps(sessionId, src.dbSteps, src.jsonlSteps);

  const indices = [
    ...new Set([...src.dbSteps.keys(), ...src.jsonlSteps.keys()]),
  ].sort((a, b) => a - b);
  const steps = indices.map((idx) =>
    buildStep(idx, src.dbSteps.get(idx), src.jsonlSteps.get(idx), src),
  );

  const children =
    INCLUDE_SUBAGENTS && depth === 0 ? loadChildSessions(steps, depth) : [];
  return {
    id: sessionId,
    meta: src.meta,
    steps,
    warnings: src.warnings,
    children,
    summaryTitle: src.checkpointTitle,
    incidents: detectIncidents(steps),
    sources: src.sources,
  };
}

function buildStep(idx, dbRow, jsonlRow, src) {
  const typeCode = dbRow?.step_type ?? null;
  const type =
    jsonlRow?.type ?? (typeCode != null ? stepTypeName(typeCode) : "?");
  const payload = dbRow?.step_payload;
  const step = {
    idx,
    type,
    typeCode,
    status:
      jsonlRow?.status ??
      (dbRow ? (STATUS_NAMES[dbRow.status] ?? String(dbRow.status)) : null),
    source:
      jsonlRow?.source ??
      (type === "USER_INPUT"
        ? "USER_EXPLICIT"
        : SYSTEM_STEP_TYPES.has(type)
          ? "SYSTEM"
          : "MODEL"),
    createdAt:
      jsonlRow?.created_at ??
      (dbRow
        ? epochSecondsToIso(protoInt(payload, PROTO.stepCreatedAt))
        : null),
    updatedAt: dbRow
      ? epochSecondsToIso(protoInt(payload, PROTO.stepUpdatedAt))
      : null,
    completedAt: null,
    messageArrivedAt: null,
    content: "",
    contentOrigin: null,
    toolCalls: jsonlRow?.tool_calls ?? null,
    thinking: jsonlRow?.thinking || null,
    requestId: dbRow
      ? (protoText(payload, PROTO.stepRequestInfo)?.match(/req_\w+/)?.[0] ??
        null)
      : null,
    inJsonl: !!jsonlRow,
    inDb: !!dbRow,
    details: {},
  };

  if (jsonlRow && jsonlRow.content != null) {
    step.content = jsonlRow.content;
    step.contentOrigin = "transcript_full.jsonl content";
    const completed = /Completed At: (\S+)/.exec(jsonlRow.content);
    if (completed)
      step.completedAt = new Date(completed[1])
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z");
  }

  if (dbRow) {
    if (type === "SYSTEM_MESSAGE")
      attachInboundMessage(step, payload, src.inboxMessages);
    else if (!jsonlRow) extractHiddenContent(step, payload);
    if (dbRow.error_details) {
      const errorMessage = protoText(dbRow.error_details, PROTO.errorMessage);
      if (errorMessage) {
        step.details.error = errorMessage;
        step.contentOrigin = (step.contentOrigin || "") + " + error_details /2";
      }
    }
    if (dbRow.metadata && !step.toolCalls) {
      const toolUseId = Buffer.from(dbRow.metadata)
        .toString("latin1")
        .match(/toolu_\w+/)?.[0];
      if (toolUseId) step.details.toolUseId = toolUseId;
    }
    if (dbRow.metadata) {
      const metaTool = protoText(dbRow.metadata, PROTO.metaToolName);
      if (metaTool && /^[a-z][a-z0-9_]{2,60}$/.test(metaTool)) {
        step.details.metaTool = metaTool;
        const callId = protoText(dbRow.metadata, PROTO.metaToolCallId);
        if (callId && /^[A-Za-z0-9_-]{3,80}$/.test(callId))
          step.details.metaToolCallId = callId;
      }
      const metaPermission = protoText(dbRow.metadata, PROTO.metaPermission);
      if (metaPermission && /^[a-z_]{3,30}$/.test(metaPermission))
        step.details.metaPermission = metaPermission;
    }
  }

  if (src.taskLogs.has(idx)) {
    step.details.taskLog = src.taskLogs.get(idx);
    step.contentOrigin =
      (step.contentOrigin ?? "") + ` + tasks/task-${idx}.log`;
  }
  if (src.commandOutputSizes.has(idx)) {
    step.details.outputFile = `steps/${idx}/output.txt`;
    step.details.outputBytes = src.commandOutputSizes.get(idx);
  }
  if (type === "INVOKE_SUBAGENT")
    step.details.children = [
      ...step.content.matchAll(/"conversationId":\s*"([0-9a-f-]{36})"/g),
    ].map((match) => match[1]);
  if (type === "USER_INPUT") {
    const request = userRequestOf(step.content);
    if (request) step.details.request = request;
  }
  return step;
}

function attachInboundMessage(step, payload, inboxMessages) {
  const messageId = protoText(payload, PROTO.messageId);
  step.details.messageId = messageId;
  step.details.sender = protoText(payload, PROTO.messageSender);
  step.details.messageTitle = protoText(payload, PROTO.messageTitle);
  const message = messageId ? inboxMessages.get(messageId) : null;
  if (message) {
    step.messageArrivedAt = message.timestamp;
    step.details.messageFile = message.file;
    step.details.priority = message.priority;
    step.details.sourceMetadata = message.sourceMetadata ?? null;
  } else {
    const timestamp = /timestamp=(\S+)/.exec(
      protoText(payload, PROTO.messageRaw) || "",
    );
    if (timestamp) step.messageArrivedAt = timestamp[1];
  }
  if (!step.inJsonl) {
    const body =
      message?.content ??
      protoText(payload, PROTO.messageBody) ??
      protoText(payload, PROTO.messageRaw) ??
      "";
    step.content = `[${step.details.messageTitle ?? "Message"}] sender=${step.details.sender ?? "?"}\n${body}`;
    step.contentOrigin = message
      ? `${message.file} content (+ SQLite /114)`
      : "SQLite step_payload /114/2/2";
  }
  if (step.details.sender)
    step.source =
      step.details.sender === "system"
        ? "SYSTEM"
        : `MSG:${step.details.sender}`;
}

function extractHiddenContent(step, payload) {
  if (step.type === "CHECKPOINT") {
    const title = protoText(payload, PROTO.checkpointTitle),
      summary = protoText(payload, PROTO.checkpointSummary);
    step.content = [
      title ? `Título/objetivo: ${title}` : null,
      summary ? `Resumen: ${summary}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    step.contentOrigin = "SQLite step_payload /30/4 + /30/5";
  } else if (step.type === "MCP_TOOL_CALL") {
    step.content = `${protoText(payload, PROTO.mcpToolName) ?? "mcp"} ${protoText(payload, PROTO.mcpToolArgs) ?? ""}`;
    step.contentOrigin = "SQLite step_payload /5/4/2 + /5/4/3";
  } else {
    for (const { path, origin } of textPathCandidates(step.type)) {
      const text = protoText(payload, path);
      if (text) {
        step.content = text;
        step.contentOrigin = `SQLite step_payload ${pathKey(path)} (ruta ${origin})`;
        break;
      }
    }
  }
  if (step.type === "PLANNER_RESPONSE" && !step.toolCalls) {
    const toolCalls = plannerToolCallsFromProto(payload);
    if (toolCalls.length) {
      step.toolCalls = toolCalls;
      step.contentOrigin =
        (step.contentOrigin
          ? step.contentOrigin + " + "
          : "SQLite step_payload ") + "/20/7 (tool_calls)";
    }
  }
  if (!step.content && !step.toolCalls?.length) {
    const longest = longestTextField(payload);
    step.content = longest.text;
    step.contentOrigin = `SQLite step_payload ${longest.pathKey} (heurístico: texto más largo)`;
  }
}

function plannerToolCallsFromProto(payload) {
  return protoValues(payload, PROTO.plannerToolCalls)
    .map((call) => {
      let args = protoText(call, PROTO.toolCallArgs);
      try {
        args = JSON.parse(args);
      } catch {
        /* argumentos no JSON: se conservan como texto */
      }
      return {
        id: protoText(call, PROTO.toolCallId),
        name: protoText(call, PROTO.toolCallName),
        args,
      };
    })
    .filter((call) => call.name);
}

function loadChildSessions(steps, depth) {
  const rolesByInvocation = new Map();
  for (const step of steps) {
    if (step.type !== "PLANNER_RESPONSE" || !step.toolCalls) continue;
    for (const call of step.toolCalls) {
      if (call.name !== "invoke_subagent") continue;
      (call.args?.Subagents ?? []).forEach((subagent, i) =>
        rolesByInvocation.set(`${step.idx}:${i}`, subagent.Role),
      );
    }
  }
  const children = [];
  for (const step of steps) {
    if (step.type !== "INVOKE_SUBAGENT" || step.status === "ERROR") continue;
    const planner = [...steps]
      .reverse()
      .find((s) => s.idx < step.idx && s.type === "PLANNER_RESPONSE");
    (step.details.children || []).forEach((childId, i) => {
      const child = reconstructSession(childId, depth + 1);
      child.role =
        rolesByInvocation.get(`${planner?.idx}:${i}`) ??
        child.summaryTitle ??
        childId.slice(0, 8);
      children.push(child);
    });
  }
  return children;
}

// ─────────────────────────────────────────────────────────────────────────────
// Incidencias: señales deterministas de los propios pasos, con los pasos que las siguieron (sin juzgar la reacción)
// ─────────────────────────────────────────────────────────────────────────────

const RETAINED_MESSAGE_THRESHOLD_SECONDS = 10;
const RESUMPTION_GAP_MS = 3600e3;
const stripToolResultHeader = (content) =>
  content.replace(/^Created At: .*\n(Completed At: .*\n)?\s*/, "");
const stripMessageHeader = (content) =>
  content.replace(/^[\s\S]*?content=/, "");

function detectIncidents(steps) {
  const incidents = [];
  const reactionAfter = (i) =>
    steps
      .slice(i + 1, i + 4)
      .map(
        (s) =>
          `${s.idx}·${s.type}${s.status === "ERROR" ? " ⚠" : ""}: ${excerpt(contentCell(s), 80)}`,
      )
      .join(" ⟶ ");
  const add = (step, i, kind, detail) =>
    incidents.push({
      idx: step.idx,
      time: step.createdAt,
      kind,
      detail: excerpt(detail, 220),
      reaction: reactionAfter(i),
    });

  // Cada señal se busca solo en el tipo de paso que la produce, para no confundirla con texto citado o reimpreso
  // por un comando (p. ej. un volcado posterior que muestra pasos antiguos).
  steps.forEach((step, i) => {
    const content = step.content || "";
    const isSystemMessage = step.type === "SYSTEM_MESSAGE";

    if (
      step.status === "ERROR" ||
      step.type === "ERROR_MESSAGE" ||
      step.details.error
    )
      add(
        step,
        i,
        "error",
        step.details.error || stripToolResultHeader(content),
      );

    if (isSystemMessage && /Timer cancelled|Timer Cancelled/.test(content))
      add(
        step,
        i,
        "timer cancelado",
        stripMessageHeader(content.replace(/^\[.*?\] sender=\S+\n?/, "")),
      );
    else if (
      step.details.taskLog &&
      /Timer cancelled/.test(step.details.taskLog) &&
      !steps.some(
        (s) =>
          s.type === "SYSTEM_MESSAGE" &&
          (s.details.sender || "").endsWith(`/task-${step.idx}`),
      )
    ) {
      add(
        step,
        i,
        "timer cancelado (según el log de la tarea)",
        step.details.taskLog
          .split("\n")
          .filter((line) => /Timer cancelled/.test(line))
          .join(" "),
      );
    }

    if (isSystemMessage && /has gone idle/.test(content))
      add(step, i, "subagente inactivo (idle)", stripMessageHeader(content));
    if (isSystemMessage && /server restart/.test(content))
      add(step, i, "reinicio del servidor", stripMessageHeader(content));

    if (step.type === "USER_INPUT") {
      const modelChange =
        /changed setting `Model Selection` from (.+?) to (.+?)\.(?:\s|$)/.exec(
          content,
        );
      if (modelChange)
        add(
          step,
          i,
          "cambio de modelo",
          `${modelChange[1]} → ${modelChange[2]}`,
        );
    }

    if (step.type !== "USER_INPUT" && step.type !== "PLANNER_RESPONSE") {
      const killed =
        /^Successfully killed (\d+) subagent[^\n]*(?:\n(Killed roles: [^\n]*))?/.exec(
          stripToolResultHeader(content),
        );
      if (killed)
        add(
          step,
          i,
          "subagentes terminados",
          `${killed[1]} subagente(s). ${killed[2] ?? ""}`,
        );
    }

    if (step.messageArrivedAt && step.createdAt) {
      const arrived = toMillis(step.messageArrivedAt),
        appended = toMillis(step.createdAt);
      const delaySeconds = Math.round((appended - arrived) / 1000);
      // Anexar un mensaje unos segundos después de su llegada es la mecánica normal; solo se señala a partir del umbral.
      if (delaySeconds >= RETAINED_MESSAGE_THRESHOLD_SECONDS) {
        const generation = steps
          .slice(0, i)
          .reverse()
          .find(
            (s) =>
              s.type === "PLANNER_RESPONSE" &&
              toMillis(s.createdAt) <= arrived &&
              toMillis(s.updatedAt || s.createdAt) >= arrived,
          );
        const during = generation
          ? `, durante la generación del paso ${generation.idx} (${formatTime(generation.createdAt)} → ${formatTime(generation.updatedAt)})`
          : ", sin generación en curso identificada";
        add(
          step,
          i,
          "mensaje retenido",
          `llegó ${formatTime(step.messageArrivedAt)}, anexado ${formatTime(step.createdAt)} (+${delaySeconds} s)${during}`,
        );
      }
    }

    const previous = steps[i - 1];
    if (previous?.createdAt && step.createdAt) {
      const gap = toMillis(step.createdAt) - toMillis(previous.createdAt);
      if (gap > RESUMPTION_GAP_MS)
        add(
          step,
          i,
          "reanudación tras pausa",
          `${(gap / 3600e3).toFixed(1)} h desde el paso ${previous.idx} (${formatTime(previous.createdAt)})`,
        );
    }
  });
  return incidents.sort((a, b) => a.idx - b.idx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────────

const heading = (level, text) => `${"#".repeat(level)} ${text}`;

// Un paso GENERIC no dice qué se hizo; el nombre de la herramienta se recupera de `metadata` y se muestra entre
// paréntesis, marcado como inferido en la ficha del paso. Los pasos con un tipo específico conservan la etiqueta
// que da el registro.
const typeLabel = (step) =>
  step.type === "GENERIC" && step.details.metaTool
    ? `${step.type} (${step.details.metaTool})`
    : step.type;
const NO_HEADER_STRIP_TYPES = new Set([
  "PLANNER_RESPONSE",
  "USER_INPUT",
  "CONVERSATION_HISTORY",
]);
const toolArgSummaryKeys = [
  "TargetFile",
  "AbsolutePath",
  "CommandLine",
  "DirectoryPath",
  "Prompt",
];

function toolCallSummary(call) {
  const args = call.args && typeof call.args === "object" ? call.args : {};
  const mainArg =
    toolArgSummaryKeys.map((key) => args[key]).find((v) => v !== undefined) ??
    (args.Subagents ? `${args.Subagents.length} subagentes` : undefined) ??
    args.DurationSeconds ??
    Object.entries(args).find(
      ([key, value]) =>
        typeof value === "string" &&
        !["toolAction", "toolSummary"].includes(key),
    )?.[1] ??
    (typeof call.args === "string" ? call.args : "");
  return `${call.name}(${excerpt(String(mainArg), 60)})`;
}

function contentCell(step) {
  let body = step.content || "";
  if (step.type === "USER_INPUT" && step.details.request)
    body = step.details.request;
  else if (!NO_HEADER_STRIP_TYPES.has(step.type))
    body = body
      .replace(/^Created At: .*\n?/m, "")
      .replace(/^Completed At: .*\n?/m, "")
      .trim();
  if (step.type === "PLANNER_RESPONSE" && step.toolCalls?.length)
    body =
      (body ? body + " " : "") +
      "⟶ " +
      step.toolCalls.map(toolCallSummary).join(", ");
  if (step.details.error && !body.includes(step.details.error.slice(0, 60)))
    body = `⚠ ${step.details.error}${body ? " — " + body : ""}`;
  return excerpt(body);
}

function sourceCell(step, prefix = "") {
  const source = step.source || "";
  const label =
    source === "USER_EXPLICIT"
      ? "usuario"
      : source === "MODEL"
        ? "modelo"
        : source === "SYSTEM"
          ? "sistema"
          : source.startsWith("MSG:")
            ? `mensaje de ${source.slice(4, 12)}${source.includes("/task-") ? " (timer)" : ""}`
            : source;
  return prefix + label;
}

function startCell(step) {
  const created = formatTime(step.createdAt);
  return step.messageArrivedAt
    ? `${created} (llegada ${formatTime(step.messageArrivedAt)})`
    : created;
}

function endCell(step) {
  if (step.completedAt) return formatTime(step.completedAt);
  if (
    step.type === "PLANNER_RESPONSE" &&
    step.updatedAt &&
    step.updatedAt !== step.createdAt
  )
    return `~${formatTime(step.updatedAt)}`;
  return "";
}

function timelineRow(step, label, sourcePrefix = "") {
  const typeCell = `${typeLabel(step)}${step.status === "ERROR" ? " ⚠ ERROR" : ""}`;
  const originCell = `${escapeCell(step.contentOrigin || "")}${step.inJsonl ? "" : " · **oculto en JSONL**"}`;
  return `| ${label} | ${startCell(step)} | ${endCell(step)} | ${typeCell} | ${sourceCell(step, sourcePrefix)} | ${escapeCell(contentCell(step))} | ${originCell} |`;
}

function renderValidationSection(level) {
  const rows = validationRows();
  const failed = rows.filter((r) => !r.ok).length;
  const verdict = failed
    ? `**⚠ ${failed} comprobación(es) no superadas**: sus extracciones pueden ser incorrectas.`
    : "Todas las comprobaciones superadas.";
  const lines = [
    heading(level, "Validación de supuestos sobre este volcado"),
    "",
    `Los supuestos del script se contrastan con los ${calibration.createdAtAgreement.checked} pasos visibles (con registro en SQLite y en el JSONL) de las ${calibration.calibratedSessions.size} sesiones calibradas. ${verdict}`,
    "",
    "| Comprobación | Muestras | Resultado |",
    "|---|---|---|",
  ];
  for (const r of rows)
    lines.push(`| ${r.check} | ${r.samples} | ${r.result} |`);
  return lines;
}

// Lo que la tabla `steps` no cuenta: qué modelo respondió en cada generación y qué llevaba el prompt de sistema.
// Sale de `gen_metadata`, no de los pasos, y por eso no altera ninguna línea temporal.
function renderContextSection(session, level) {
  const c = session.meta.context;
  if (!c) return [];
  const lines = [
    "",
    heading(level, "Contexto del modelo (`gen_metadata`)"),
    "",
  ];
  lines.push(
    `\`gen_metadata\` guarda una fila por generación: ${c.generations} en esta sesión. La fila mayor (índice ${c.largestIdx ?? "-"}, ${c.largestBytes} bytes) contiene el contexto acumulado que se envió al modelo, prompt de sistema incluido.`,
    "",
  );
  lines.push("| Modelo | Generaciones en que aparece |", "|---|---|");
  if (c.models.size)
    for (const [name, n] of [...c.models].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    ))
      lines.push(`| \`${name}\` | ${n} |`);
  else lines.push("| - | - |");
  lines.push("");
  lines.push(
    `Etiquetas \`<…>\` halladas en esa fila (incluye etiquetas del propio contenido, no solo bloques del prompt): ${c.tags.length ? c.tags.map((t) => `\`<${t}>\``).join(", ") : "-"}`,
    "",
  );
  lines.push(
    `Inyección \`<planning_mode>\`: ${c.planningInGen ? "presente en `gen_metadata`" : "ausente en `gen_metadata`"} · pasos de \`steps\` que la contienen: ${c.planningInSteps}.`,
    "",
  );
  return lines;
}

function renderIncidentsSection(session, level) {
  const rows = session.incidents.map((incident) => ({
    label: String(incident.idx),
    incident,
  }));
  for (const child of session.children)
    for (const incident of child.incidents)
      rows.push({
        label: `${child.id.slice(0, 8)}#${incident.idx} (${child.role})`,
        incident,
      });
  const lines = ["", heading(level, "Incidencias"), ""];
  if (!rows.length) {
    lines.push(
      "Sin incidencias detectadas (errores, timers cancelados, subagentes inactivos, reinicios, cambios de modelo, subagentes terminados, mensajes retenidos ≥ 10 s entre llegada y anexado, pausas > 1 h).",
    );
    return lines;
  }
  lines.push(
    "| Paso | Hora | Incidencia | Detalle | Reacción (3 pasos siguientes) |",
    "|---|---|---|---|---|",
  );
  for (const { label, incident } of rows)
    lines.push(
      `| ${label} | ${formatTime(incident.time)} | ${incident.kind} | ${escapeCell(incident.detail)} | ${escapeCell(incident.reaction || "(fin de la sesión)")} |`,
    );
  return lines;
}

function renderStepDetail(step, label, level) {
  const timing = [
    formatTime(step.createdAt),
    step.messageArrivedAt
      ? `llegada ${formatTime(step.messageArrivedAt)}`
      : null,
    step.completedAt
      ? `fin ${formatTime(step.completedAt)}`
      : step.updatedAt && step.updatedAt !== step.createdAt
        ? `act. ${formatTime(step.updatedAt)}`
        : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const facts = [
    `fuente: ${sourceCell(step)}`,
    `estado: ${step.status ?? "-"}`,
    `origen del contenido: ${step.contentOrigin ?? "-"}`,
    step.details.error ? `error_details: ${step.details.error}` : null,
    step.requestId ? `request id: ${step.requestId}` : null,
    step.details.toolUseId ? `tool_use_id: ${step.details.toolUseId}` : null,
    step.details.messageId ? `message id: ${step.details.messageId}` : null,
    step.details.outputFile
      ? `salida íntegra: ${step.details.outputFile} (${step.details.outputBytes} bytes)`
      : null,
    step.details.metaTool
      ? `herramienta: ${step.details.metaTool} (inferida de steps.metadata /4/2${step.details.metaToolCallId ? `, call id ${step.details.metaToolCallId}` : ""})`
      : null,
    step.details.metaPermission
      ? `permiso: ${step.details.metaPermission} (steps.metadata /34/4)`
      : null,
    step.inJsonl ? null : "solo en SQLite",
  ].filter(Boolean);
  const fence = (text) => text.replace(/```/g, "``​`");
  const lines = [
    heading(level, `${label} — ${typeLabel(step)} · ${timing}`),
    facts.map((f) => `- ${f}`).join("\n"),
    "",
  ];
  lines.push("```text", fence(step.content || "(vacío)"), "```", "");
  if (step.toolCalls?.length)
    lines.push(
      "tool_calls:",
      "```json",
      fence(JSON.stringify(step.toolCalls, null, 2)),
      "```",
      "",
    );
  if (options.thinking && step.thinking)
    lines.push("thinking:", "```text", fence(step.thinking), "```", "");
  if (step.details.taskLog)
    lines.push(
      `tasks/task-${step.idx}.log:`,
      "```text",
      step.details.taskLog.trim(),
      "```",
      "",
    );
  return lines;
}

function renderSessionMarkdown(session, summary, level = 1) {
  const hiddenSteps = session.steps
    .filter((s) => s.inDb && !s.inJsonl)
    .map((s) => s.idx);
  const lines = [
    heading(
      level,
      `Línea temporal — sesión \`${session.id}\`${summary.title ? ` — ${summary.title}` : ""}`,
    ),
    "",
  ];
  lines.push("| Campo | Valor |", "|---|---|");
  lines.push(
    `| Título | ${escapeCell(summary.title || "(sin título)")} _(${summary.titleSource || "-"})_ |`,
  );
  lines.push(`| trajectory_id | \`${session.meta.trajectoryId ?? "-"}\` |`);
  lines.push(
    `| Workspace | ${session.meta.workspaces.map((w) => `\`${w}\``).join(", ") || "-"} |`,
  );
  lines.push(
    `| Modelos (gen_metadata) | ${session.meta.models.join(", ") || "-"} |`,
  );
  lines.push(
    `| Rango | ${formatTime(summary.first)} → ${formatTime(summary.last)} |`,
  );
  lines.push(
    `| Pasos | SQLite: ${session.steps.filter((s) => s.inDb).length} · JSONL: ${session.steps.filter((s) => s.inJsonl).length} · solo en SQLite (${hiddenSteps.length}): ${hiddenSteps.length ? hiddenSteps.join(", ") : "ninguno"} |`,
  );
  lines.push(
    `| Fuentes | db=${session.sources.db} · ${session.sources.jsonl ?? "sin jsonl"} · messages=${session.sources.messages} · tasks=${session.sources.tasks} · steps/N/output.txt=${session.sources.outputs} |`,
  );
  lines.push(
    `| Artefactos | ${summary.artifacts.map((a) => `\`${a}\``).join(", ") || "-"} |`,
  );
  lines.push(`| Zona horaria | ${TIME_ZONE} |`);
  if (session.warnings.length)
    lines.push(`| Avisos | ${session.warnings.map(escapeCell).join(" · ")} |`);
  lines.push("");
  if (level === 1) lines.push(...renderValidationSection(level + 1), "");
  lines.push(
    "Columnas: **Inicio** = `created_at` del JSONL o campo protobuf `/5/1/1` (para mensajes entrantes, además la hora de llegada del mensaje). **Fin** = `Completed At` del resultado de herramienta; en pasos del modelo, `~` + última actualización del paso (`/5/7/1`, fin de generación). **Origen** = de dónde se ha extraído literalmente el contenido.",
    "",
  );
  lines.push(
    "| Paso | Inicio | Fin | Tipo | Fuente | Contenido | Origen |",
    "|---|---|---|---|---|---|---|",
  );

  const rows = session.steps.map((step) => ({
    time: step.createdAt || "",
    idx: step.idx,
    line: timelineRow(step, String(step.idx)),
  }));
  for (const child of session.children) {
    for (const step of child.steps)
      rows.push({
        time: step.createdAt || "",
        idx: step.idx,
        line: timelineRow(
          step,
          `${child.id.slice(0, 8)}#${step.idx}`,
          `↳ ${child.role}: `,
        ),
      });
  }
  if (session.children.length)
    rows.sort((a, b) => a.time.localeCompare(b.time) || a.idx - b.idx);
  for (const row of rows) lines.push(row.line);

  lines.push(...renderIncidentsSection(session, level + 1));
  lines.push(...renderContextSection(session, level + 1));

  if (options.full) {
    lines.push("", heading(level + 1, "Detalle por paso"), "");
    for (const step of session.steps)
      lines.push(...renderStepDetail(step, `Paso ${step.idx}`, level + 2));
    for (const child of session.children) {
      lines.push(
        heading(level + 1, `Subagente ${child.role} — \`${child.id}\``),
        "",
      );
      for (const step of child.steps)
        lines.push(
          ...renderStepDetail(
            step,
            `${child.id.slice(0, 8)}#${step.idx}`,
            level + 2,
          ),
        );
    }
  }
  return lines.join("\n") + "\n";
}

function renderProjectMarkdown(summaries) {
  const summaryById = new Map(summaries.map((s) => [s.id, s]));
  const sessionById = new Map(
    summaries.map((s) => [s.id, reconstructSession(s.id)]),
  );
  const parentOf = new Map();
  for (const [id, session] of sessionById) {
    for (const step of session.steps) {
      if (step.type !== "INVOKE_SUBAGENT") continue;
      for (const childId of step.details.children || [])
        if (!parentOf.has(childId)) parentOf.set(childId, id);
    }
  }
  const childrenOf = (id) =>
    [...parentOf]
      .filter(([, parentId]) => parentId === id)
      .map(([childId]) => childId);
  const isRoot = (summary) =>
    !parentOf.has(summary.id) || !summaryById.has(parentOf.get(summary.id));
  const ordered = summaries.slice().sort(byStartTime);
  const firsts = summaries
      .map((s) => s.first)
      .filter(Boolean)
      .sort(),
    lasts = summaries
      .map((s) => s.last)
      .filter(Boolean)
      .sort();
  const models = new Set(),
    workspaces = new Set();
  for (const session of sessionById.values())
    for (const model of session.meta.models) models.add(model);
  for (const summary of summaries)
    for (const workspace of summary.workspaces) workspaces.add(workspace);
  const rootCount = summaries.filter(isRoot).length;

  const lines = [
    heading(
      1,
      `Historial de Antigravity — ${WORKSPACE_FILTER ? `proyecto «${WORKSPACE_FILTER}»` : "sesiones seleccionadas"}`,
    ),
    "",
  ];
  lines.push("| Campo | Valor |", "|---|---|");
  lines.push(
    `| Raíz de logs | \`${ROOT}\` |`,
    `| Workspaces | ${[...workspaces].map((w) => `\`${w}\``).join(", ") || "-"} |`,
  );
  lines.push(
    `| Sesiones | ${summaries.length} (${rootCount} raíz · ${summaries.length - rootCount} subagentes de otra sesión del historial) |`,
  );
  lines.push(
    `| Rango | ${formatTime(firsts[0])} → ${formatTime(lasts.at(-1))} |`,
    `| Modelos | ${[...models].sort().join(", ") || "-"} |`,
    `| Zona horaria | ${TIME_ZONE} |`,
    "",
  );

  lines.push(
    heading(2, "Sesiones"),
    "",
    "| # | Sesión | Inicio | Fin | Pasos SQLite/JSONL/solo SQLite | Incid. | Modelos | Título | Relación |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  ordered.forEach((summary, i) => {
    const session = sessionById.get(summary.id),
      parentId = parentOf.get(summary.id),
      childIds = childrenOf(summary.id);
    const relation = parentId
      ? `hijo de \`${parentId.slice(0, 8)}\`${summaryById.has(parentId) ? "" : " (padre fuera del filtro)"}`
      : childIds.length
        ? `padre de ${childIds.map((id) => `\`${id.slice(0, 8)}\`${summaryById.has(id) ? "" : "*"}`).join(", ")}`
        : "raíz";
    const stepCounts = `${session.steps.filter((s) => s.inDb).length}/${session.steps.filter((s) => s.inJsonl).length}/${session.steps.filter((s) => s.inDb && !s.inJsonl).length}`;
    lines.push(
      `| ${i + 1} | \`${summary.id}\` | ${formatTime(summary.first)} | ${formatTime(summary.last)} | ${stepCounts} | ${session.incidents.length} | ${session.meta.models.join(", ") || "-"} | ${escapeCell(summary.title || "(sin título)")} | ${relation} |`,
    );
  });
  if ([...parentOf.keys()].some((childId) => !summaryById.has(childId)))
    lines.push(
      "",
      "`*` subagente cuyo workspace no coincide con el filtro (no incluido).",
    );
  lines.push("", ...renderValidationSection(2), "", "---", "");

  if (options.merged) {
    lines.push(
      heading(2, "Historial cronológico conjunto"),
      "",
      "Todas las sesiones en una sola tabla, ordenadas por hora de inicio del paso. **Sesión** = 8 primeros caracteres del id (ver tabla anterior).",
      "",
    );
    lines.push(
      "| Sesión | Paso | Inicio | Fin | Tipo | Fuente | Contenido | Origen |",
      "|---|---|---|---|---|---|---|---|",
    );
    const rows = [];
    ordered.forEach((summary, order) => {
      for (const step of sessionById.get(summary.id).steps)
        rows.push({
          time: step.createdAt || "",
          order,
          idx: step.idx,
          line: timelineRow(
            step,
            `\`${summary.id.slice(0, 8)}\` | ${step.idx}`,
          ),
        });
    });
    rows.sort(
      (a, b) =>
        a.time.localeCompare(b.time) || a.order - b.order || a.idx - b.idx,
    );
    for (const row of rows) lines.push(row.line);
    return lines.join("\n") + "\n";
  }

  const rendered = new Set();
  const renderTree = (summary, level) => {
    if (rendered.has(summary.id)) return;
    rendered.add(summary.id);
    lines.push(
      renderSessionMarkdown(sessionById.get(summary.id), summary, level),
    );
    for (const childId of childrenOf(summary.id)) {
      if (!summaryById.has(childId)) continue;
      if (INCLUDE_SUBAGENTS) rendered.add(childId);
      else renderTree(summaryById.get(childId), Math.min(level + 1, 5));
    }
  };
  for (const summary of ordered) if (isRoot(summary)) renderTree(summary, 2);
  for (const summary of ordered) renderTree(summary, 2);
  return lines.join("\n") + "\n";
}

function sessionToJson(session, summary) {
  const serialize = (s) => ({
    id: s.id,
    role: s.role ?? null,
    meta: s.meta,
    sources: s.sources,
    warnings: s.warnings,
    incidents: s.incidents,
    events: s.steps.map((step) => ({
      ...step,
      thinking: options.thinking ? step.thinking : undefined,
    })),
  });
  // JSON.stringify no sabe serializar BigInt ni Map: los BigInt pasan a número y los Map a objeto.
  const jsonSafe = (key, value) =>
    typeof value === "bigint"
      ? Number(value)
      : value instanceof Map
        ? Object.fromEntries(value)
        : value;
  return (
    JSON.stringify(
      {
        session: summary,
        validation: validationRows(),
        ...serialize(session),
        children: session.children.map(serialize),
      },
      jsonSafe,
      2,
    ) + "\n"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Programa principal
// ─────────────────────────────────────────────────────────────────────────────

if (options.batch) {
  if (!options.out) {
    console.error("--batch necesita --out <directorio>.");
    process.exit(1);
  }
  const outDir = resolve(options.out);
  mkdirSync(outDir, { recursive: true });
  const ids = listSessionIds();
  const historyTitles = indexTitlesFromConversationHistory();
  let written = 0;
  for (const id of ids) {
    resetCalibration();
    try {
      learnFromSessions([id]);
      const session = reconstructSession(id);
      const summary = summarizeSession(id, historyTitles);
      const text =
        options.format === "json"
          ? sessionToJson(session, summary)
          : renderSessionMarkdown(session, summary);
      writeFileSync(
        join(outDir, `${id}.${options.format === "json" ? "json" : "md"}`),
        text,
      );
      written += 1;
    } catch (error) {
      console.error(
        `aviso ${id.slice(0, 8)}: no se ha podido generar el informe (${error.message})`,
      );
    }
  }
  console.error(`escritos ${written} de ${ids.length} informes en ${outDir}`);
  writeConsultedRoutes();
  process.exit(written === ids.length ? 0 : 4);
}

const selection = selectSessions();
let output;
if (selection.list) {
  output = renderSessionList(selection.list) + "\n";
} else if (selection.multi) {
  for (const summary of selection.multi)
    if (summary.warning)
      console.error(`aviso ${summary.id.slice(0, 8)}: ${summary.warning}`);
  learnFromSessions(selection.multi.map((s) => s.id));
  output =
    options.format === "json"
      ? JSON.stringify(
          {
            filter: { workspace: WORKSPACE_FILTER },
            validation: validationRows(),
            sessions: selection.multi.map((s) =>
              JSON.parse(sessionToJson(reconstructSession(s.id), s)),
            ),
          },
          null,
          2,
        ) + "\n"
      : renderProjectMarkdown(selection.multi);
} else {
  learnFromSessions([selection.session.id]);
  const session = reconstructSession(selection.session.id);
  output =
    options.format === "json"
      ? sessionToJson(session, selection.session)
      : renderSessionMarkdown(session, selection.session);
  for (const warning of session.warnings) console.error(`aviso: ${warning}`);
}

if (options.out) {
  mkdirSync(dirname(resolve(options.out)), { recursive: true });
  writeFileSync(options.out, output);
  console.error(`escrito ${options.out} (${output.length} caracteres)`);
} else {
  process.stdout.write(output);
}

// Escribe la lista de rutas consultadas durante esta ejecución. Se llama al terminar, tanto un informe normal
// como un --batch, porque la lista solo está completa cuando ya se han recorrido las sesiones.
function writeConsultedRoutes() {
  if (!options["routes-out"]) return;
  const target = resolve(options["routes-out"]);
  mkdirSync(dirname(target), { recursive: true });
  const routes = [...consultedRoutes].sort((a, b) => b[1] - a[1]);
  writeFileSync(
    target,
    JSON.stringify(
      {
        reader: "reconstruir-sesion.mjs",
        generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        routes: routes.map(([route]) => route),
        requests: Object.fromEntries(routes),
      },
      null,
      2,
    ) + "\n",
  );
  console.error(`escrito ${options["routes-out"]} (${routes.length} rutas)`);
}

writeConsultedRoutes();
