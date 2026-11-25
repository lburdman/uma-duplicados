# Resultados medidos y detalle

El `README.md` es el one-pager que pide el enunciado. Acá está todo lo que no entraba:
las mediciones completas, la validación cruzada por OCR y las discrepancias con el
enunciado. El *por qué* de cada decisión vive en `docs/decisions/`.

```bash
pnpm install
pnpm start ./lote                 # las tres etapas: PDFs → SQLite → JSON
pnpm test                         # 99 tests, incluye idempotencia y fuga de PII
pnpm eval <ground-truth.json>     # precisión y recall contra el archivo que le pases
```

El flujo son **tres etapas separadas, con SQLite como frontera**, y cada una corre sola:

```bash
pnpm extract ./lote    # 1. lee los PDFs y guarda ítems estructurados
pnpm detect            # 2. adjudica duplicados leyendo de la base — no abre un PDF
pnpm report            # 3. reproyecta items.json y hallazgos.json desde la base
```

Esa separación es deliberada: si cambiás una regla, `pnpm detect` te da hallazgos nuevos
sobre exactamente los mismos bytes guardados, sin volver a extraer
([ADR 0008](decisions/0008-staged-pipeline.md)).

Requiere Node ≥ 22.6 y `pdftotext` (poppler: `brew install poppler`). El LLM corre con
un mock determinístico por defecto; `LLM_PROVIDER=anthropic` usa el modelo real.

## Extracción — poppler con coordenadas de palabra

Las 146 páginas son una grilla fija de Crystal Reports con capa de texto embebida. OCR
re-derivaría lo que el archivo ya dice, y un LLM multimodal por página cuesta plata y
latencia por página y no es bit-reproducible — y este pipeline promete que dos corridas
dan lo mismo. Uso `pdftotext -bbox-layout` y **reconstruyo la tabla geométricamente**,
no por flujo de texto ([ADR 0001](decisions/0001-geometric-extraction.md)).

Tres cosas del lote rompen el enfoque por líneas de texto: las filas se cortan y siguen
en la línea siguiente e incluso cruzando páginas (un regex por línea lee 1.731 de 2.169
filas); las columnas de dinero son derecha-alineadas, así que `264947,00` empieza a la
izquierda del ancla de `Hon.`; y el anonimizador dejó fragmentos de nombre pintados en
x ≈ 527, justo donde arranca el código de nomenclador
([ADR 0002](decisions/0002-name-residue.md)).

**Resultado medido:** 2.169 de 2.169 filas leídas, y los tres documentos reconcilian
**al centavo** contra el `TOTAL:` que el prestador imprimió en cada uno.

**Los tiers 2 y 3.** Ninguna página de este lote los necesita, pero están implementados y
son ejecutables, porque un fallback que nadie vio correr es un fallback que no funciona.
La cadena decide **por página**, no por documento, y el disparador es "esta página no
produjo ninguna fila" — no un umbral de cantidad de palabras, que es apenas un proxy y
además engañoso: un escaneo con encabezado digital estampado *tiene* texto. Cada motor se
construye recién cuando una página lo necesita, y si no está disponible (no es una Mac, no
hay API key) degrada a un warning en vez de tirar el lote
([ADR 0007](decisions/0007-extraction-tiers.md)).

```bash
pnpm ocr lote/detalle_ANONIMIZADO.pdf 1                       # texto vs OCR sobre la misma página
pnpm ocr:fallback lote/detalle_ANONIMIZADO.pdf 1              # fabrica una página sin texto → tier 2
pnpm ocr:fallback lote/detalle_ANONIMIZADO.pdf 1 --no-vision  # sin tier 2 → cae al tier 3
```

| Página 1 | capa de texto | Vision OCR |
|---|---|---|
| palabras | 254 | 252 |
| filas reconstruidas | 15 | 15 |
| ítems parseados | 15 | 15 |
| suma de la columna Total | 449.958,27 | **449.958,27** |
| tiempo (32 páginas) | 180 ms | 82.285 ms |

100 % de coincidencia en afiliado, fecha y monto en las 15 filas. Es **~450× más lento**,
que es todo el argumento para que sea fallback y no default. `pnpm ocr:fallback`
rasteriza una página real, la reenvuelve como PDF sin capa de texto (poppler lee 0
palabras) y demuestra que el OCR la rescata con la misma suma al centavo.

**El lote entero también corre por OCR** (`EXTRACTOR=ocr`), y comparar fila por fila
contra la capa de texto es lo que expone dos defectos que ningún test unitario iba a
encontrar — uno de ellos descartaba una página entera por un acento mal leído en el
encabezado, y es un defecto de la capa de texto también:

| | capa de texto | Vision OCR |
|---|---|---|
| filas leídas | 2.169 | **2.169** |
| documentos que reconcilian | 3 de 3 | **3 de 3, delta 0,00** |
| ítems normalizados | 2.150 | 1.994 |
| ítems no extraídos | 19 | 175 |
| hallazgos | 7 | **los mismos 7 ids** |

De los 1.994 ítems que produjeron los dos, **paciente, fecha y monto coinciden en el
100 %**. El único campo que difiere es el código de práctica, en 20 ítems. El OCR no
produce datos *equivocados*: produce *menos* datos, y los 156 que faltan están en
`unextracted` con su motivo.

| Documento | Páginas | Filas | Ítems | No extraídos |
|---|---|---|---|---|
| `detalle_ANONIMIZADO.pdf` | 32 | 478 | 474 | 4 |
| `detalle_(1)_ANONIMIZADO.pdf` | 61 | 906 | 905 | 1 |
| `detalle_(2)_ANONIMIZADO.pdf` | 53 | 785 | 771 | 14 |

**19 ítems no extraídos (0,88 %), $1.232.005,64.** Todos por el mismo motivo: el Nro. de
Afiliado no tiene 13 dígitos (15 malformados, 4 vacíos) y no se puede partir en CUIL +
sufijo sin adivinar. Adivinar fusiona dos hermanos en un paciente — débito falso — o
parte un paciente en dos — duplicado perdido. Van a `unextracted` con su motivo y su
importe. La reconciliación se calcula sobre **todas** las filas leídas, no sobre los
ítems normalizados, así que el 100 % de la plata está contabilizada.

## Detección — reglas primero, LLM sólo para la zona gris

Bloqueo por (paciente, práctica canónica, fecha) → 43 grupos candidatos, 73 pares.
Brute force habría comparado 2.310.175. La clave **no incluye el monto** (los precios
están versionados: `340213` cotiza 48.609,10 en enero y 55.104,96 en febrero) y **sí
incluye el sufijo de afiliado** (hay 7 casos de mismo CUIL, misma práctica, misma fecha
y sufijo distinto: son hermanos, y agrupar por CUIL genera 7 débitos falsos).

| Capa | Regla | Grupos | Veredicto |
|---|---|---|---|
| 1 | `R5-SINGLE-PER-DAY` | 7 | **duplicado** |
| 1 | `R4-SUBSEQUENT-EXPOSURE` | 9 | legítimo |
| 1 | `R1-MEDICATION-OUT-OF-SCOPE` | 4 | legítimo |
| 1 | `R3-DIFFERENT-PRACTICE-TEXT` | 1 | legítimo |
| 2 | LLM → `NOT_DUPLICATE` | 22 | legítimo |

`R4` descansa en evidencia del lote, no en una corazonada: los códigos de exposición
subsiguiente (340202/340210/340212/340302) aparecen 46 veces y en **46 de 46** conviven
con su código de primera exposición para el mismo afiliado y la misma fecha. Cero
excepciones.

`R3` salió de abrir la página 32 de `detalle_(1)` y leer la fila. Un afiliado tiene dos
veces el código `420101` el mismo día en la misma guardia, mismo importe — pero uno dice
`CONSULTA MEDICA` y el otro `CONSULTA GINECOLOGICA`. `420101` es simplemente "consulta":
el código es el contenedor y la descripción impresa distingue la especialidad. Son dos
atenciones distintas, y sin esa regla el sistema debitaba una. Es el único caso del lote,
y no lo encontré leyendo código.

La capa 2 **no emite nada en este lote**, y eso es lo que tiene que hacer: esos 22
grupos son exactamente los que un detector ingenuo habría debitado. Su aporte se mide
en falsos positivos evitados ([ADR 0004](decisions/0004-two-layer-detection.md)).

**7 hallazgos, $486.658,66 a debitar.**

## Dónde quedan los datos

Todo vive en SQLite (`out/hallazgos.db`), y los JSON son una **proyección** de ahí, no
la fuente:

| Tabla | Filas | Qué guarda |
|---|---|---|
| `documents` | 3 | hash de contenido, páginas, totales leído/impreso, si reconcilia, extractor |
| `items` | 2.150 | un ítem facturado normalizado, con página, confianza y warnings |
| `unextracted_items` | 19 | lo que no se pudo leer, con motivo e importe |
| `findings` | 7 | el hallazgo con su monto a debitar |
| `finding_items` | 14 | la evidencia, marcando cuál cargo se retiene y cuáles se debitan |
| `finding_traces` | 7 | regla, versiones, prompt, modelo, respuesta cruda, inputs exactos |
| `decisions` | 43 | **los 43 grupos**, no sólo los que emitieron |
| `schema_migrations` | 1 | versión del esquema |

## Idempotencia

Ninguna identidad se genera: el id de documento es el hash del contenido del archivo, el
de ítem es `documento:nroInterno`, y el de hallazgo es el hash de
`tipo|paciente|práctica|fecha|ítems ordenados`. Todo escribe con `ON CONFLICT DO UPDATE`.
No hay chequeo de "¿ya vi esto?" en el código, porque la base no puede representar el
duplicado.

Tres cosas hubo que sacar para que se sostenga: el timestamp de wall-clock en la traza
(es un input de la corrida, no un efecto), el orden no determinístico (archivos, ítems,
hallazgos y todas las queries de proyección tienen orden explícito), y escribir el JSON
desde memoria — se **proyecta desde SQLite**, así que que los bytes sean idénticos es
evidencia de que los upserts cayeron en las mismas filas
([ADR 0005](decisions/0005-idempotency-by-identity.md)).

Verificado por test: dos corridas seguidas producen `items.json` y `hallazgos.json`
byte-idénticos y el mismo conteo en las siete tablas.

## Costo

Son dos costos distintos y reportarlos como uno esconde el trade-off que el enunciado
pide justificar.

**Extracción — sin costo de API sobre este lote.** Cero llamadas de red: `pdftotext`,
`pdfinfo`, `pdftoppm` y el binario de Vision corren todos en esta máquina. Eso no es
suerte: es la razón de que el tier que cobra por página sea el último de la cadena y no el
primero. Poner un modelo multimodal al frente le pondría precio por página a la única
etapa que escala con páginas. Acá lo que cuesta es CPU.

| | |
|---|---|
| Llamadas de red | **0** |
| Costo de API | **USD 0,00** |
| Cómputo | 733 ms leyendo 146 páginas = **5,0 ms/página** |
| Proyección | ≈ **1,4 horas-CPU por millón de páginas** |
| Con OCR forzado (tier 2) | 2,6 s/página → ≈720 horas-CPU por millón |
| Si una página cayera al tier 3 | USD 0,0159 sync · USD 0,0079 batch (`claude-sonnet-5`) |

**Detección — el único costo de API del pipeline.**

| | |
|---|---|
| Pares resueltos **sin** LLM | 31 |
| Pares resueltos **con** LLM | 42 (22 llamadas sobre 43 grupos) |
| Pares nunca comparados | 2.310.102 (los elimina el bloqueo) |
| Tokens | 15.091 in / 880 out |
| Costo real | **USD 0** — el provider por defecto es un mock, y lo digo |
| A precio de lista | USD 0,097455 sobre `claude-opus-5` |
| **De API por documento** | **USD 0,032** |

## Trazabilidad

Dado un `findingId`, una query devuelve regla, versión de regla, versión de política de
repetibilidad, versión de bloqueo, extractor, prompt, versión de prompt, modelo, la
respuesta cruda y los inputs exactos:

```sql
SELECT * FROM finding_traces WHERE finding_id = ?;
```

La tabla `decisions` guarda **los 43 grupos**, no sólo los 7 que emitieron. Un auditor
—o el abogado del prestador— va a preguntar tarde o temprano por qué *ese otro* no se
marcó, y una tabla de hallazgos no puede responder eso.

## Datos sensibles

El Nro. de Afiliado contiene el CUIL, que contiene el DNI: es documento de identidad. El
sink del logger scrubea todo mensaje y todo campo antes de escribir — cualquier corrida
de 8+ dígitos se va como `[REDACTED_ID]` —, la correlación usa un HMAC salado, y el LLM
recibe la referencia redactada, nunca el CUIL
([ADR 0006](decisions/0006-pii.md)). Hay tests que fallan si algo se filtra.

## Precisión y recall

`pnpm eval <ground-truth.json>` imprime precisión, recall y F1 contra el archivo que le
pases, más la lista de qué emitió de más y qué se perdió.

**No hay ground truth en este repo.** El enunciado promete `esperado.json` y el lote
entregado tiene cuatro PDFs y ningún JSON, así que el comando no trae ninguno propio ni
tiene ruta por defecto: recibe el archivo por argumento y falla con un mensaje claro si
no se lo pasás. Acepta tanto un array plano con la forma de `hallazgos.json` como un
objeto con una clave `esperados`; la clave de comparación es tipo + lista ordenada de
`itemId`, que no contiene ningún dato de paciente.

Lo que sí puedo afirmar sobre la calidad: **los 7 hallazgos están verificados a mano
abriendo los PDFs en la página que indica la evidencia**, y los 43 grupos candidatos
están todos en la tabla `decisions` con su regla y su motivo.

## Discrepancias con el enunciado

- **"Algunos duplicados cruzan dos PDFs".** En este lote no hay ninguno. Sobre 2.150
  ítems no existe un solo grupo (paciente, práctica, fecha) que abarque más de un
  documento, con o sin canonicalización de alias. Hay 6 casos de mismo paciente y misma
  fecha en dos documentos, pero con prácticas distintas (una RMN en uno y una Rx en el
  otro). El detector agrupa sin mirar el documento, así que los encontraría; hay un test
  que lo afirma para que si un lote futuro los tiene, se note.
- **"Facturas y planillas de rendición".** Los tres documentos son planillas de
  rendición. No hay ninguna factura.
- **`esperado.json` no fue entregado.** `pnpm eval` lo consume si aparece, en cualquiera
  de las dos formas plausibles, pero no trae ni asume ninguno.

## Si el lote fuera de 1.000.000 de páginas/día

- **La extracción es lo único que escala con las páginas** y es vergonzosamente
  paralela: una página no depende de otra. Un pool de workers por documento, y el
  binario de poppler detrás de una cola. Medido por el propio comando sobre este lote:
  5,0 ms por página, o sea ~1,4 horas-CPU por millón — 16 workers lo hacen en minutos, y
  sin un centavo de API. La `TextExtractor` es un puerto
  justamente para poder meter OCR detrás para el subconjunto sin capa de texto, sin
  tocar el resto.
- **La detección ya es lineal.** El bloqueo es un hash join sobre (paciente, práctica,
  fecha); acá tira 2,3 millones de pares. A escala, esa clave es una tabla particionada
  y el bloqueo es un `GROUP BY`, no un `Map` en memoria.
- **SQLite se queda corto**, no por el volumen de datos sino por la escritura
  concurrente. Postgres con la misma identidad derivada de contenido: los upserts siguen
  siendo idempotentes y ahora también concurrentes, que es la propiedad que realmente
  hace falta cuando hay 60 workers escribiendo.
- **El costo del LLM se mantiene acotado por diseño**, no por suerte: en este lote toca
  el 1 % de los ítems. Lo que agregaría es cachear el veredicto por (código, cantidad,
  patrón), porque la zona gris se repite muchísimo — 18 de los 22 grupos escalados son
  el mismo código.
- **La tabla de repetibilidad es el cuello de botella real.** Cubre 15 códigos; el
  nomenclador tiene miles. A escala eso deja de ser un archivo TypeScript y pasa a ser
  una tabla versionada con dueño médico, y el flujo pasa a ser: el LLM propone una
  clasificación, un auditor la aprueba, y a partir de ahí ese código lo resuelve la capa
  1 gratis y para siempre.

## Qué sé que falta

Ordenado por valor, no por esfuerzo. Ninguna de éstas es especulativa: todas salieron de
correr el sistema y mirar lo que hizo.

1. **Cache de veredictos del LLM.** `pnpm detect` re-ejecuta las 22 llamadas cada vez.
   Con provider real eso es plata en cada re-corrida aunque no haya cambiado nada, y
   re-correr detección es justamente el flujo que habilité al separar las etapas. Se
   arregla guardando un fingerprint del input en `decisions` y salteando la llamada
   cuando coinciden fingerprint, versión de prompt y modelo.
2. **La tabla de repetibilidad cubre 15 de los 75 códigos del lote.** El resto cae en
   `UNKNOWN` y va al LLM. Es el cuello de botella real a escala, y el flujo correcto es:
   el LLM propone una clasificación, un auditor la aprueba, y desde ahí la capa 1 la
   resuelve gratis para siempre.
3. **La métrica de eval es todo-o-nada.** `matchKey` exige igualdad exacta del conjunto
   de ítems, así que un hallazgo que agarra 2 de 3 cargos duplicados cuenta como falso
   positivo *y* como falso negativo. Para un auditor eso es un acierto parcial. Se
   arregla con matching por solapamiento, pero el umbral es una decisión de negocio.
4. **Los archivos WAL sobreviven a la corrida.** `hallazgos.db-wal` y `-shm` quedan
   sueltos. Cosmético; un `PRAGMA wal_checkpoint(TRUNCATE)` al cerrar los limpia.
5. **No hay índices sobre `decisions` ni `finding_traces`.** Con 43 y 7 filas da igual;
   con millones, la consulta de trazabilidad va a full scan.

## Qué quedó afuera

- **Segundo extractor (`pdfjs-dist`) como control cruzado.** El gate de reconciliación
  cumple esa función contra un número que firmó el prestador, en vez de contra otra
  implementación de mis propios supuestos. Y cuando hace falta una segunda opinión sobre
  una página, `pnpm ocr` pone dos motores genuinamente independientes sobre ella.
- **Ground truth propio.** Saldría del mismo análisis que produjo la tabla de reglas, así
  que mediría consistencia interna y no validez. `pnpm eval` consume el archivo que se le
  pase.
- **Otros tipos de desvío.** El campo `tipo` es un enum extensible con un único valor.
  El enunciado sólo describe y pide duplicados.
- **Reproducibilidad del OCR entre versiones de macOS.** El modelo de Vision viene con
  el sistema operativo. Un lote extraído por OCR mantiene la idempotencia dentro de una
  máquina y la pierde al actualizar. Queda registrado el extractor y su versión en cada
  documento para que el cambio se vea, y `OCR_FALLBACK=off` lo desarma.
