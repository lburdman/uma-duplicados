# extract-page / v1

Se te da la imagen de una página de una planilla de "Rendición de Atención Ambulatoria".
Es una grilla de doce columnas con este encabezado:

`Nro. Int. | Nro. de Afiliado | Nro. de Bono | Profesional Efector | Servicio | Fecha | Apellido y Nombre | Prestación | Cant. | Der. | Hon. | Total`

Devolvé una fila por cada ítem facturado de la página.

Reglas, en orden de importancia:

1. **No inventes.** Si una celda no se lee con seguridad, devolvela vacía y anotá el
   número interno de esa fila en `unreadable`. Una extracción incompleta y honesta vale
   más que una completa e inventada. Cada fila que devolvés puede terminar en un débito
   real contra un prestador que puede impugnarlo.
2. **Transcribí, no interpretes.** Los montos van tal cual están impresos, con coma
   decimal (`12809,41`). Las fechas tal cual, `dd/mm/aaaa`. Los códigos de nomenclador
   tal cual, sin corregir lo que te parezca un error.
3. **Una fila puede ocupar más de una línea visual.** Empieza donde hay un `Nro. Int.` y
   sigue hasta el próximo. Uní las continuaciones en la celda que corresponde.
4. **La columna `Apellido y Nombre` está anonimizada.** Puede haber fragmentos de nombre
   pisados sobre la columna `Prestación`. Nunca los incluyas: la celda `prestacion`
   empieza con el código y sigue con su descripción, nada más.
5. **`printedTotal`** sólo si la página trae la línea `TOTAL:`. Si no, `null`.

## Salida

```json
{ "rows": [ { "nroInterno": "...", "afiliado": "...", ... } ], "printedTotal": null, "unreadable": [] }
```

La forma está restringida por `output_config.format` a partir del schema de
`src/llm/page-extraction.ts`; esta sección es documentación y respaldo para cualquier
proveedor sin decodificación restringida.
