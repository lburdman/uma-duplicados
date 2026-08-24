# PRD — Detección de prácticas duplicadas en rendiciones de prestadores

Este documento define **qué** hace el sistema y **por qué** cada límite está donde está.
El *cómo* de cada decisión vive en `docs/decisions/`; los números medidos, en `README.md`
y en `docs/resultados.md`.

## 1. Problema

Una financiadora de salud recibe de sus prestadores documentación de facturación: planillas
de rendición con miles de ítems. Parte de esos ítems son **desvíos**: cosas que no
corresponde pagar. El desvío más común es la **práctica duplicada** — el mismo estudio
facturado dos veces al mismo paciente.

Hoy ese control es manual y no escala: el lote de esta prueba son 146 páginas y 2.169
ítems, y un lote real puede ser de un millón de páginas por día.

El problema no es "encontrar filas parecidas". Es **decidir**. Cada hallazgo aprobado se
convierte en un débito real de dinero al prestador, y el prestador puede impugnarlo. Un
falso positivo no cuesta solo la plata que se devuelve: cuesta la credibilidad del sistema
entero de auditoría. Eso define todo lo demás en este documento.

## 2. Usuarios

| Usuario | Relación con el sistema | Qué necesita |
|---|---|---|
| **Auditor médico** | Usuario primario. Aprueba o rechaza cada hallazgo. | Evidencia que le permita abrir el PDF, ir a la página y ver el ítem con sus propios ojos. Sin eso no puede aprobar nada. |
| **Prestador que impugna** | No usa el sistema, pero sus objeciones lo definen. | Que el débito sea reconstruible: qué regla se aplicó, con qué versión, sobre qué ítems. |
| **Equipo de datos** | Mantiene y evoluciona el pipeline. | Trazabilidad, idempotencia y métricas para saber si un cambio mejoró o empeoró la detección. |

El prestador es el usuario adversarial. **Diseñamos para que resista su impugnación.**

## 3. Alcance

- Extracción de ítems facturados desde los PDFs del lote, con **tres tiers encadenados por
  página**: capa de texto, OCR local, modelo multimodal.
- Normalización a un modelo de dominio canónico (paciente, práctica, fecha, monto).
- Detección de **un solo tipo de hallazgo**: `PRACTICA_DUPLICADA`.
- Detección determinística sin LLM para los casos resolubles por regla.
- Desambiguación con LLM únicamente para la zona gris.
- Persistencia en SQLite con identidad determinística de hallazgo, y las tres etapas
  ejecutables por separado con la base como frontera.
- Salidas `items.json` y `hallazgos.json` reproyectadas desde la base.
- Comando de evaluación con precisión y recall, y cola de revisión de lo declinado.

## 4. Fuera de alcance

Explícitamente excluidos por el enunciado: UI, autenticación, Docker, tests exhaustivos,
base de datos pesada, CI, deploy.

Excluidos por decisión propia:

- **Otros tipos de desvío.** El enunciado pide un campo `tipo` en el hallazgo, lo que
  sugiere más de un tipo, pero solo describe y solicita duplicados. Modelamos `tipo` como
  enum extensible y emitimos un único valor.
- **Corrección de datos.** Si un ítem no se puede extraer con confianza, se registra como
  no extraído. Nunca se completa, se infiere ni se inventa. Vale también para un código de
  nomenclador que salió mal leído y que "obviamente" es otro: repararlo es inferencia
  disfrazada de extracción.
- **Segundo extractor como control cruzado.** El gate de reconciliación al centavo cumple
  esa función contra un número que firmó el prestador, en vez de contra otra
  implementación de mis propios supuestos (ADR 0001).
- **Ground truth propio.** `pnpm eval` mide contra el archivo que se le pase; no trae
  ninguno. Ver AC-5.

## 5. Entradas

Directorio con PDFs de rendición (`pnpm start ./lote`). El lote de referencia contiene tres
planillas `* Rendición de Atención Ambulatoria *` generadas por Crystal Reports, con doce
columnas y layout idéntico:

`Nro. Int. | Nro. de Afiliado | Nro. de Bono | Profesional Efector | Servicio | Fecha | Apellido y Nombre | Prestación | Cant. | Der. | Hon. | Total`

| Documento | Páginas | Ítems | Fechas de servicio |
|---|---|---|---|
| `detalle_ANONIMIZADO.pdf` | 32 | 478 | 16/12/2025 – 20/02/2026 |
| `detalle_(1)_ANONIMIZADO.pdf` | 61 | 906 | 22/01/2026 – 20/04/2026 |
| `detalle_(2)_ANONIMIZADO.pdf` | 53 | 785 | 21/12/2025 – 20/02/2026 |

**Discrepancia con el enunciado:** el enunciado describe el lote como "facturas y planillas
de rendición". Los tres documentos son planillas de rendición. No hay ninguna factura.

## 6. Salidas

**`items.json`** — todos los ítems extraídos, cada uno con documento, página, número interno,
paciente normalizado, código de práctica normalizado, fecha ISO, cantidad, montos,
`confidence` y `warnings`. Más un bloque `unextracted` con los ítems no extraídos y su motivo.

**`hallazgos.json`** — un registro por hallazgo con `tipo`, `paciente`, `practica`,
`montoADebitar`, `evidencia[]` (documento, página, número interno, monto por ítem) y `traza`
(regla o prompt aplicado, versión, modelo, inputs, timestamp).

Ambos archivos se reproyectan desde SQLite con orden determinístico.

## 7. Criterios de aceptación

Numerados según los seis requisitos del enunciado. AC-7 no es un requisito numerado: está en
el cuerpo del texto, en la sección de extracción.

| # | Requisito | Criterio verificable |
|---|---|---|
| **AC-1** | Salida | `pnpm start ./lote` escribe `items.json` y `hallazgos.json`. Cada hallazgo trae tipo, paciente, práctica, monto a debitar y evidencia con documento y página por ítem. Un auditor puede abrir el PDF en esa página y ver el ítem. |
| **AC-2** | Idempotencia | Dos corridas consecutivas sobre el mismo lote producen archivos **byte-idénticos** y la misma cantidad de filas en SQLite. Verificado por test. |
| **AC-3** | Costo | El pipeline reporta pares evaluados sin LLM, pares evaluados con LLM, y costo por documento. La detección de duplicados obvios no invoca al LLM ni una vez. |
| **AC-4** | Trazabilidad | Dado un `findingId`, una consulta SQL devuelve la regla o prompt aplicado, su versión, el modelo y los inputs exactos. |
| **AC-5** | Evals | `pnpm eval <archivo>` imprime precisión y recall contra el archivo que se le pase. Si no se pasa ninguno, falla con mensaje claro. |
| **AC-6** | Datos sensibles | Ningún log contiene nombre ni número de afiliado. Un test corre el pipeline y falla si aparece un afiliado en formato reconocible o un fragmento de nombre. |
| **AC-7** | Extracción honesta | Los ítems no extraídos con confianza se registran en `unextracted` con su motivo y se cuentan en el README. La suma de montos leídos reconcilia contra el total impreso de cada documento. |

**Sobre AC-5.** El enunciado dice "Te damos `esperado.json` con los hallazgos correctos". El
archivo **no fue entregado**: el lote contiene cuatro PDFs y ningún JSON. `pnpm eval` recibe
el archivo por argumento, acepta las dos formas plausibles (array plano tipo `hallazgos.json`
u objeto con clave `esperados`) y no trae ni asume ninguno. Un ground truth propio no
resolvería esto: saldría del mismo análisis que produjo la tabla de reglas, así que mediría
consistencia interna y no validez. La afirmación de calidad que sí se sostiene es otra: los
7 hallazgos están verificados a mano abriendo los PDFs en la página que indica la evidencia,
y los 43 grupos candidatos están en la tabla `decisions` con su regla y su motivo.

## 8. Decisiones tomadas ante ambigüedad

| Ambigüedad | Decisión | Motivo |
|---|---|---|
| El enunciado no define el esquema de `items.json` | Esquema propio validado con Zod, aplicado en `parseRow` antes de que el ítem exista | No hay contrato externo que respetar |
| `tipo` sugiere varios tipos de hallazgo, pero solo se pide duplicados | Enum extensible con un único valor | No inventar desvíos que nadie pidió |
| No hay `esperado.json` | `pnpm eval` recibe el archivo por argumento | Un ground truth propio mediría consistencia interna, no validez |
| Ítems con afiliado ausente o malformado | Van a `unextracted`, no a detección | Sin identidad de paciente no se puede evaluar duplicación |
| Duda entre emitir y no emitir un hallazgo | **No emitir** | ADR 0003 — sesgo hacia el falso negativo |

## 9. Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **Agrupar por CUIL sin sufijo** | Genera débitos falsos entre hermanos. Hay 7 casos en el lote: mismo CUIL, misma fecha, mismo código, sufijo distinto. | La clave de paciente es CUIL + sufijo. Test dedicado. |
| **Alias de código de práctica** | `341012`, `3410121`, `3410123` y `3410126` son el mismo estudio al mismo precio. Comparar por código crudo pierde duplicados reales. | Canonicalización estructural previa al bloqueo: un código de 7 dígitos colapsa a su prefijo de 6 sólo si ese prefijo existe en el lote. |
| **Falsos positivos por códigos de exposición subsiguiente** | Estos códigos repiten legítimamente el mismo código el mismo día: 46 apariciones en el lote. | Regla de exclusión determinística. Las 46 conviven con su código base, sin excepción. |
| **Extracción por posición horizontal ingenua** | El anonimizador dejó fragmentos de nombre pintados sobre el código de nomenclador en 262 de las 2.169 filas. Un desempate incorrecto mete un nombre dentro del código y parte montos. | Reconstrucción por runs de texto (ADR 0002), reconciliación al centavo, y canonicalización de descripciones como defensa en profundidad. |
| **Comparar montos entre períodos** | Los precios están versionados: `340213` cotiza entre 48.609,10 y 55.104,96 según el período. | El monto no participa de la clave de duplicado. |
| **Fuga de PII** | El número de afiliado contiene el CUIL, que contiene el DNI. | Redacción por diseño en el logger. Test que falla si hay fuga. |
| **Costo del LLM** | Un LLM aplicado a todos los pares es caro e innecesario. | Reglas primero. La zona gris del lote son 42 pares en 22 grupos, sobre 2.150 ítems. |
| **Alucinación en el tier 3** | Un modelo puede devolver un cargo que no está en la página, y esa falla es silenciosa y bien formada. | Las filas generativas pagan 0,25 de confianza y quedan bajo el piso de 0,8 que exige la detección: pueden rescatar una página, no pueden generar un débito. |
