# Orden de lectura

Para entender el código y poder defenderlo en vivo. El orden sigue el recorrido del dato,
no el listado de carpetas. Son 4.746 líneas de `src` y 1.245 de tests, pero **el 60 % de
las preguntas van a caer sobre cuatro archivos**, marcados con ★.

Cada bloque dice qué buscar, porque leer un archivo sin saber qué pregunta responde es
perder el tiempo.

---

## 0. Antes de abrir un `.ts` — las decisiones (30 min)

No arranques por el código. Si no podés explicar *por qué* está hecho así, poder explicar
*cómo* no te salva.

| | Qué contesta |
|---|---|
| `README.md` | Qué hace, con qué números, y qué sé que falta |
| `PRD.md` | Qué está adentro del alcance, qué afuera, y qué se decidió ante cada ambigüedad |
| `docs/decisions/0001-geometric-extraction.md` | Por qué coordenadas de palabra y no texto plano |
| `docs/decisions/0003-false-negative-bias.md` ★ | **La decisión que gobierna todo el resto** |
| `docs/decisions/0008-staged-pipeline.md` | Por qué tres etapas con la base en el medio |

Si solo leés uno, que sea el 0003. Todas las reglas, todos los umbrales y todos los
"no emitimos" salen de ahí.

---

## 1. El vocabulario (~210 líneas, 15 min)

Los tipos que usa todo lo demás. Chicos y densos.

| Archivo | Qué buscar |
|---|---|
| `src/domain/money.ts` | La plata vive en centavos enteros. Por eso la reconciliación compara al centavo y no "con un epsilon" |
| `src/domain/dates.ts` | Rechaza el 31/02 en vez de rolearlo |
| `src/domain/member.ts` ★ | **La trampa de los hermanos.** La clave de paciente es CUIL + sufijo. Agrupar por CUIL genera 7 débitos falsos en este lote |
| `src/domain/practice.ts` | Práctica vs medicamento. `250101` vs `21068X1` |
| `src/extraction/billing-item.ts` | El contrato. Todo lo de abajo produce esto, todo lo de arriba lo consume |

---

## 2. Extracción (~1.050 líneas) — el corazón técnico

| Archivo | Qué buscar |
|---|---|
| `src/extraction/document-reader.ts` ★ | **El puerto agnóstico de verdad.** Devuelve filas, no palabras. Leé el comentario de arriba: explica por qué un LLM multimodal no entra en `TextExtractor` |
| `src/extraction/ports.ts` | Leé el comentario de `positionTolerance`. Es la precisión posicional como propiedad del motor, no como constante mágica |
| `src/extraction/poppler-extractor.ts` | Corre `pdftotext -bbox-layout` y parsea el XML. Nada más |
| `src/extraction/table.ts` ★★ | **El archivo más importante del proyecto** |
| `src/extraction/parse-row.ts` | Celdas → `BillingItem`, con confianza y warnings. Acá se decide qué va a `unextracted` |
| `src/extraction/extract-document.ts` | El gate de reconciliación contra el `TOTAL:` impreso |
| `src/extraction/canonicalize-descriptions.ts` | Defensa en profundidad contra fuga de nombres |

### Cómo leer `table.ts`

410 líneas, pero son cinco funciones independientes. Leelas en este orden y probá cada
una mentalmente contra una fila real:

1. **`groupIntoLines`** — agrupa palabras en líneas visuales por banda vertical.
2. **`readColumnAnchors`** — encuentra el encabezado y saca las anclas de columna.
   Mirá `headerKey`: acá vive el bug que costó una página entera por un acento.
3. **`assignColumn`** — asigna cada palabra a una columna. **La sutileza**: las columnas
   de texto van por borde izquierdo, las de dinero por borde derecho, porque están
   derecha-alineadas y `264947,00` empieza a la izquierda del ancla de `Hon.`.
4. **`separateTextRuns`** ★ — separa el residuo de anonimización. Si te preguntan una
   sola cosa técnica, va a ser ésta. El ejemplo del comentario (`420101 GINA VANESA
   CONSULTA MEDICA`) es literal, sale de la página 4 del documento B.
5. **`readTable`** — arma las filas lógicas. Una fila abre en `Nro. Int.` y absorbe
   continuaciones, incluso cruzando páginas.

---

## 3. Detección (~840 líneas) — el corazón del negocio

Acá es donde vas a pasar la mitad de la defensa.

| Archivo | Qué buscar |
|---|---|
| `src/detection/blocking.ts` | La clave NO lleva monto (precios versionados) y SÍ lleva sufijo (hermanos). Y por qué el aliasing de códigos es puramente estructural |
| `src/detection/practice-policy.ts` | La tabla que decide si una práctica puede repetirse en el día. **Leé las evidencias, no los códigos** |
| `src/detection/rules.ts` ★★ | **Las seis reglas, en orden.** Cada una previene un falso positivo que podés señalar con el dedo en el PDF |
| `src/detection/finding.ts` | Identidad determinística del hallazgo. Fijate qué NO entra en el hash: timestamp, orden, nombre de archivo |
| `src/detection/detect.ts` | Orquesta las dos capas y cuenta pares con y sin LLM |
| `src/detection/disambiguate.ts` | Qué ve el modelo. Referencia redactada, nunca el CUIL |

**La pregunta que te van a hacer:** "¿por qué esta regla y no otra?". La respuesta está en
el comentario de cada una, y todas menos una salen de contar sobre el lote. La excepción
es `R3-DIFFERENT-PRACTICE-TEXT`, que salió de abrir la página 32 y leer la fila — decilo
así, porque es cierto y porque muestra que no te quedaste en la estadística.

---

## 4. Los bordes (~1.340 líneas)

Leelos cuando entiendas el centro. Ninguno tiene lógica de negocio.

| Archivo | Qué buscar |
|---|---|
| `src/observability/logger.ts` | El sink scrubea. Redacción por diseño, no por disciplina |
| `src/llm/decision-schema.ts` | Un schema, dos usos: restringe al decoder y valida la respuesta |
| `src/llm/mock-provider.ts` | Por qué el mock nunca dice DUPLICATE |
| `src/llm/anthropic-provider.ts` | El JSON no se pide por prompt, se restringe en el decoder |
| `src/persistence/schema.ts` | Toda clave primaria se deriva del contenido. Ahí vive la idempotencia |
| `src/persistence/repository.ts` | `loadItems` es la frontera entre etapa 1 y 2. Y mirá el comentario de `retractStaleFindings` |
| `src/persistence/projections.ts` | Por qué el JSON se proyecta desde SQL y no desde memoria |
| `src/pipeline/stages.ts` | Las tres etapas. `runDetection` no recibe el directorio del lote: no puede abrir un PDF |
| `src/pipeline/run.ts` | Composition root. El único lugar que elige provider, extractor y rutas |

---

## 5. Tiers 2 y 3 de extracción (~760 líneas) — opcional, sólo si preguntan

| Archivo | Qué buscar |
|---|---|
| `docs/decisions/0007-extraction-tiers.md` | Empezá acá: los tres tiers, por qué el puerto devuelve filas, los dos bugs que expuso correr el lote entero por OCR, y el Batch API |
| `src/pipeline/run.ts` → `selectReader` | Cómo se arma la cadena y qué la desarma por env |
| `src/extraction/vision-ocr-extractor.ts` | Rasteriza y llama al binario. Poco más |
| `tools/ocr/vision-ocr.swift` | Caja por palabra, no por línea. Y la conversión de coordenadas |
| `src/llm/page-extraction.ts` | El contrato del tier 3. Un schema, dos usos |
| `src/extraction/llm-document-reader.ts` | Rasteriza a 150 dpi y marca cada fila `GENERATIVE` |
| `src/cli/extraction-chain.ts` | El demo (`pnpm ocr:fallback`): fabrica una página sin texto y la hace caer de tier en tier |

---

## 6. Los tests como guion de defensa

`tests/detection.test.ts` es, literalmente, la lista de trampas del lote con nombre y
apellido. Si lo leés en voz alta tenés media defensa hecha:

- *"a subsequent-exposure code repeats legitimately when its base code is there"*
- *"same CUIL, same practice, same day, different suffix is two patients"*
- *"same code with different printed practices is two services, not a duplicate"*
- *"a doubtful extraction never becomes a debit"*
- *"UNCERTAIN produces no debit — doubt is resolved against emitting"*

`tests/pipeline.test.ts` respalda las dos afirmaciones más fuertes del README: dos
corridas dan bytes idénticos, y ningún log contiene datos de paciente.

---

## Antes de la defensa, corré esto

```bash
pnpm start ./lote      # mirá los números salir
pnpm review            # los 22 grupos que declinamos, $1,8M sin confirmar
pnpm detect            # re-adjudica sin abrir un PDF
pnpm ocr lote/detalle_ANONIMIZADO.pdf 1
```

Y tené a mano un PDF abierto en la página 32 del documento B: es donde vive la trampa de
`CONSULTA MEDICA` vs `CONSULTA GINECOLOGICA`, y poder mostrarla en pantalla vale más que
explicarla.

---

## Si te piden un cambio chico en vivo

Los tres lugares más probables, y son los tres fáciles:

| Te piden | Tocás |
|---|---|
| "que este código también cuente como repetible" | `src/detection/practice-policy.ts`, una entrada |
| "que no debite si los montos difieren" | `src/detection/rules.ts`, una condición en `R5` |
| "bajá el umbral de confianza" | `MIN_CONFIDENCE_FOR_FINDING` en `rules.ts` |

Después de cualquiera de los tres: `pnpm detect` te muestra el efecto **sin volver a leer
los PDFs**. Ése es el momento donde se paga haber separado las etapas — mostralo.
