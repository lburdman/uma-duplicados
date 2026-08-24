# Prácticas duplicadas en rendiciones de prestadores

```bash
pnpm install                      # Node ≥ 22.6 y poppler (brew install poppler)
pnpm start ./lote                 # PDFs → SQLite → items.json + hallazgos.json
pnpm eval <ground-truth.json>     # precisión y recall contra el archivo que le pases
pnpm test                         # 95 tests: idempotencia, fuga de PII, cada falso positivo
```

Tres etapas separadas, con SQLite de frontera: `pnpm extract ./lote`, `pnpm detect`,
`pnpm report`. Cambiás una regla, corrés `detect`, y adjudicás sobre los mismos bytes
guardados sin volver a abrir un PDF.

**Extracción — poppler con coordenadas de palabra.** Las 146 páginas son una grilla fija
de Crystal Reports con capa de texto embebida. Descarté OCR (re-deriva lo que el archivo
ya dice) y LLM multimodal (cuesta y tarda por página, y no es bit-reproducible — este
pipeline promete que dos corridas dan lo mismo). Uso `pdftotext -bbox-layout` y
reconstruyo la tabla **geométricamente**: las filas se cortan y cruzan páginas, las
columnas de dinero son derecha-alineadas, y el anonimizador dejó fragmentos de nombre
pintados encima del código de nomenclador. **2.169 de 2.169 filas leídas, y los tres
documentos reconcilian al centavo contra el `TOTAL:` impreso.**

La extracción son **tres tiers encadenados por página**, del más barato y confiable al
menos: capa de texto → OCR local (Apple Vision) → modelo multimodal. El orden es a la vez
el argumento de costo y el de confianza, y coinciden: el único tier que cobra por página
es también el único cuya salida se *genera* en vez de medirse, así que es el último que se
consulta. Correr el lote entero por el tier 2 dio los **mismos 7 hallazgos**. El puerto que
los une devuelve **filas, no palabras** — un modelo multimodal no reporta dónde está la
tinta, reporta qué dice la tabla, y pedirle bounding boxes para reusar mi geometría sería
correr anclas calibradas al punto sobre coordenadas que nadie midió
([ADR 0007](docs/decisions/0007-extraction-tiers.md)). Las filas del tier 3 quedan
marcadas `GENERATIVE` y pagan 0,25 de confianza: caen en 0,75, **debajo del piso de 0,8
que exige la detección**. O sea que puede rescatar una página para el registro y para que
la lea un humano, y **no puede generar un débito solo**.

**No extraídos: 19 ítems (0,88 %), $1.232.005,64.** Todos por lo mismo: el Nro. de
Afiliado no tiene 13 dígitos y no se puede partir en CUIL + sufijo sin adivinar. Adivinar
fusiona hermanos (débito falso) o parte un paciente en dos (duplicado perdido).

**Detección — reglas primero, LLM sólo para la zona gris.** Bloqueo por (paciente,
práctica, fecha): 43 grupos, 73 pares. La clave **no** lleva monto (precios versionados)
y **sí** lleva sufijo de afiliado (7 casos de hermanos que serían débitos falsos).

| Capa | Regla | Grupos | |
|---|---|---|---|
| 1 | `R5-SINGLE-PER-DAY` | 7 | **duplicado** |
| 1 | `R4-SUBSEQUENT-EXPOSURE` | 9 | legítimo — 46 de 46 conviven con su código de 1ª exposición |
| 1 | `R1-MEDICATION-OUT-OF-SCOPE` | 4 | legítimo |
| 1 | `R3-DIFFERENT-PRACTICE-TEXT` | 1 | legítimo — mismo código, `CONSULTA MEDICA` vs `GINECOLOGICA` |
| 2 | LLM → `NOT_DUPLICATE` | 22 | legítimo |

**7 hallazgos, $486.658,66 a debitar.** La capa 2 no emite nada, y eso es lo que tiene
que hacer: esos 22 grupos son los que un detector ingenuo habría debitado.

**Idempotencia.** Ninguna identidad se genera. El id de documento es el hash del
contenido, el de ítem es `documento:nroInterno`, el de hallazgo es el hash de
`tipo|paciente|práctica|fecha|ítems ordenados`. Todo escribe con `ON CONFLICT DO UPDATE`:
no hay chequeo de "¿ya vi esto?" porque la base no puede representar el duplicado. Hubo
que sacar el timestamp de wall-clock de la traza, fijar el orden en todas las queries, y
proyectar el JSON **desde SQL** en vez de desde memoria — así que bytes idénticos es
evidencia de que los upserts cayeron en las mismas filas. Verificado por test.

**Costo, por método de extracción.** Los tres tiers, medidos sobre este lote. La única
etapa que escala con páginas es la extracción, así que ahí es donde el método importa.

| Tier | Costo de API | Cómputo | Por documento (49 pág) | Por millón de páginas |
|---|---|---|---|---|
| 1 · capa de texto (poppler) | **USD 0** — 0 llamadas de red | 5,0 ms/pág | USD 0 | USD 0 · ~1,4 h-CPU |
| 2 · OCR local (Apple Vision) | **USD 0** — on-device | 2,6 s/pág | USD 0 | USD 0 · ~720 h-CPU |
| 3 · multimodal, sync | USD 0,0159/pág | ~1 s/pág | USD 0,77 | **USD 15.880** |
| 3 · multimodal, **batch** | USD 0,0079/pág | dentro de la hora | USD 0,39 | **USD 7.940** |

El tier 3 son 2.755 tokens de entrada (2.316 de la imagen a 150 dpi, que Anthropic
redimensiona a 1568 px de lado largo, más 439 del prompt) y 1.037 de salida para una
página de 15 filas, sobre `claude-sonnet-5`. **Ese renglón es la razón del orden:** el
único tier que cobra por página es el último que se consulta, y sobre este lote se
consulta cero veces. Es también el único que manda datos fuera de la máquina, lo cual
para una financiadora de salud es una decisión aparte de la de costo.

**Costo de detección** — el otro lugar donde hay LLM, y el único que se usó: 31 pares
resueltos sin LLM, 42 con LLM (22 llamadas), 2.310.102 pares que el bloqueo nunca comparó.
Provider por defecto **mock** y lo digo: costo real USD 0. A precio de lista sobre
`claude-opus-5`, **USD 0,032 de API por documento**. Detección se queda síncrona a
propósito: 22 llamadas, centavos, y un humano esperando. La mitad de nada es nada.

**Trazabilidad.** `SELECT * FROM finding_traces WHERE finding_id = ?` devuelve regla,
versión de regla, de política, de bloqueo, extractor, prompt, versión de prompt, modelo,
respuesta cruda e inputs exactos. La tabla `decisions` guarda **los 43 grupos**, no sólo
los 7 que emitieron: el prestador va a preguntar por qué *ese otro* no se marcó.

**Datos sensibles.** El Nro. de Afiliado contiene el CUIL, que contiene el DNI: es
documento de identidad. El sink del logger scrubea todo mensaje y todo campo antes de
escribir, la correlación usa un HMAC salado, y el LLM recibe la referencia redactada.
Tests que fallan si algo se filtra.

**Precisión / recall.** `pnpm eval <archivo>` los imprime contra el archivo que se le
pase. El enunciado promete `esperado.json` y el lote entregado tiene cuatro PDFs y ningún
JSON, así que el comando no trae ni asume ninguno. Lo que sí sostengo: **los 7 hallazgos
están verificados a mano abriendo los PDFs en la página que indica la evidencia**, y
`pnpm review` muestra los 36 grupos declinados con su motivo.

**Si el lote fuera de 1.000.000 de páginas/día.** La extracción es lo único que escala con
las páginas y es vergonzosamente paralela: 5,0 ms por página medidos → ~1,4 horas-CPU por
millón, 16 workers en minutos, y sin un centavo de API. Si una fracción del lote llegara
sin capa de texto, el tier 3 en modo batch cuesta la mitad y nadie downstream lo espera:
un lote de rendición se procesa en ciclo diario. La detección ya es lineal (hash join). SQLite se queda
corto por escritura concurrente, no por volumen: Postgres con la misma identidad derivada
de contenido mantiene los upserts idempotentes *y* concurrentes. El costo del LLM está
acotado por diseño (toca el 1 % de los ítems); agregaría cache de veredictos, porque 18 de
los 22 grupos escalados son el mismo código. **El cuello de botella real es la tabla de
repetibilidad**: cubre 15 de 75 códigos, y a escala deja de ser un archivo TypeScript para
ser una tabla con dueño médico alimentada por "el LLM propone, el auditor aprueba".

**Ambigüedades que decidí solo.** (1) El enunciado dice que algunos duplicados cruzan
PDFs: en este lote **no hay ninguno**, verificado con toda clave razonable. (2) Los tres
documentos son planillas de rendición, no hay ninguna factura. (3) `tipo` es un enum
extensible con un único valor. **Qué falta:** cache de veredictos del LLM, la tabla de
repetibilidad completa, y una métrica de eval con crédito parcial.

---

`docs/resultados.md` — mediciones completas y validación cruzada por OCR ·
`docs/decisions/` — 8 ADRs con el porqué de cada decisión ·
`docs/lectura.md` — orden de lectura del código
