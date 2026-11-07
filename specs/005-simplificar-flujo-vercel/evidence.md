# Evidencia y alcance — 005

Fecha: 2026-11-08. Fase: **specify**. Este documento reúne hallazgos del producto existente y restricciones de la siguiente iteración; no selecciona arquitectura ni acredita cambios, pruebas nuevas de producto o despliegues.

## Solicitud y decisiones de alcance

- Corregir foco y halo sin perder accesibilidad; mover destinos al inicio de Recalcular con «Elegir qué celdas recalcular», automatizando únicamente lo inequívoco y conservando revisión, conflictos y omisiones.
- Concentrar todas las descargas generadas por el conjunto en Descargar, con una elección coherente y un único botón de preparación, descarga o reintento. Plantillas y demos permanecen en Cargar.
- Revisar todos los selectores, desplegables y controles de estado, conservando la información que explica una decisión. El inventario inferior delimita la revisión, no una obligación de eliminar cada control.
- Aclaración expresa: **demo pública con datos sintéticos y sesiones independientes**, sin cuentas ni SSO. Se permiten archivos sintéticos propios compatibles; un aviso no puede acreditar automáticamente que los datos son ficticios.
- Preparar frontend y backend como dos proyectos Vercel. No publicar, abrir cuentas ni contratar servicios en esta entrega; elegir proveedores y configuración corresponde al plan.
- Actualizar README al terminar la implementación y comprobar el recorrido: introducción de menos de diez líneas, arquitectura, puesta en marcha, dos diagramas y cuatro capturas finales reales. El usuario añade expresamente la declaración de desarrollo mediante **Spec Driven Development (SDD), utilizando Spec Kit**, con enlace portable a `specs/`. No se modifica README en esta fase.

La publicación de datos sintéticos es la excepción autorizada al funcionamiento exclusivamente local recogido en la constitución. No autoriza enviar informes reales a terceros ni cambia el alcance de los perfiles admitidos. La aceptación humana SC-010 de 004 permanece abierta.

## Foco y realce: diagnóstico ya reproducido

La investigación está documentada en [verification-004.md](../../docs/verification-004.md), sección «Investigación de la revisión humana — 2026-11-08», con mediciones y capturas locales. No se han repetido estas pruebas para declarar resuelta la fase 005.

La nueva petición también incluye el rectángulo al pulsar una cabecera desplegable como «Ver informes y contexto». Forma parte del alcance de corrección, sin extender automáticamente el diagnóstico del título a todos los controles ni eliminar globalmente el foco.

| Hallazgo confirmado | Consecuencia para la especificación |
| --- | --- |
| Al navegar con ratón, el título recibe foco programático pero no foco visible; aun así presenta contorno de 2 px y separación de 4 px. Con teclado sí existe foco visible. | Quitar únicamente el contorno innecesario del título tras ratón; conservar orientación y señal de teclado, también en controles y errores. |
| El botón de etapa mide 168×40 px y tiene bordes redondeados; el halo queda en la etiqueta interior de 87,17×22 px y radio 0. Es decoración, no foco. | El realce debe corresponder al botón completo sin desplazarlo. La técnica concreta se decidirá en el plan; no depender del aspecto accidental de elementos internos. |
| Las pruebas anteriores verificaban duración, foco y contraste, pero no estas diferencias geométricas. | Añadir comprobaciones observables de ratón, teclado y geometría, además de movimiento reducido y colores forzados. |

## Destinos y continuidad del recorrido

La elección actual está montada en Validar y vinculada a una ejecución completa. El guardado de configuración crea una versión aunque no cambie importes. Por tanto, trasladar la presentación sin redefinir qué resultados sirven para preparar destinos podría bloquear la simulación o producir un ciclo de configuración y revalidación.

El requisito es reutilizar resultados completos adecuados al catálogo y datos vigentes, también al entrar directamente en Recalcular, sin usar una ejecución histórica de otros datos. Un cambio solo de configuración no exige validar otra vez los mismos datos. No se debe reiniciar una elección u omisión vigente al volver a la etapa. La identidad de datos/configuración y el momento de publicación se concretarán en el plan.

Referencias de exploración: `apps/web/src/app/recalculation/directions.component.ts`, `directions.store.ts`, `preview.store.ts`, `apps/web/src/app/validation/validation-page.component.html`, `apps/web/src/app/workspace/workspace-shell.component.ts` y `apps/api/src/recalculation/direction-review-service.ts`. Se mantienen decisiones globales, paginación, conflictos, caducidad de revisiones, concurrencia y reintentos; no se pretende convertir el filtro visible en el conjunto completo de decisiones.

## Inventario de controles

Inventario del código actual: **17 tipos declarados de selectores y 11 tipos de apartados desplegables**. Un control repetido por cada regla o archivo cuenta como un tipo, no como una única instancia visible. Las acciones de apertura/cierre, selección y confirmación se inventarían aparte.

| Área | Selectores actuales | Alcance de revisión |
| --- | --- | --- |
| Contexto global (1) | Contexto de trabajo. | Dato de lectura si solo hay uno; conservar selección real y acceso al contexto. |
| Cargar (7) | Demostración; perfil de archivo ambiguo; origen del contexto; tipo de informe manual; escala; tabla presentada sí/no; estado del catálogo. | Conservar elecciones que alteran interpretación o búsqueda. No eliminar perfil ambiguo, escala o presentación de tabla por considerarlos técnicos. |
| Validar (2) | Ejecución; estado del resultado. | Ejecución de lectura cuando sea única; conservar históricos y filtros útiles. |
| Destinos (2) | Estado de revisión; lado izquierdo/derecho/omisión para reglas ambiguas. | Trasladar a Recalcular; decisiones pendientes primero y revisión opcional de lo resuelto. |
| Recalcular (2) | Historial de simulaciones; estado de propuesta. | Historial de lectura si es único; conservar estados que distinguen propuestas aplicadas, descartadas u obsoletas. |
| Descargar (3) | Versión; contenido; ejecución de resultados. | Mantener una elección coherente; mostrar controles solo si hay alternativas útiles. |

| Área | Apartados desplegables actuales | Hallazgo o utilidad |
| --- | --- | --- |
| Cargar (4) | Pasos/resultados de demo; hojas excluidas; explicación genérica de nulos; detalle de regla. | Pasos opcionales, exclusiones y regla pueden aportar valor. Reducir explicación genérica sin perder ausencia frente a cero. |
| Detalle de cálculo compartido (1) | Cómo se obtiene este importe. | Se presenta incluso sin propuesta ni operandos con intervalo: puede quedar vacío. No mostrar detalle inexistente; conservar explicación real cuando la haya. |
| Validar (1) | Formato de los resultados. | Contenido estático vinculado a una descarga que se centralizará; retirar duplicación o conservar una explicación breve si hace falta. |
| Destinos (1) | Motivos sin destino. | Separarlos de decisiones pendientes, sin perder las razones de inelegibilidad accesibles en la explicación pertinente. |
| Recalcular (2) | Revisión completa de selección; resumen completo de comparación, abierto por defecto. | Conservar revisión paginada de selección; un resumen siempre abierto no necesita un cierre sin valor. |
| Descargar (2) | Informes/contexto; hojas excluidas por archivo. | Conservar contenido y cobertura necesarios para interpretar el archivo, sin mezclar versiones ni afirmar que las hojas preservadas están validadas. |

Otros controles de estado y apertura que deben quedar cubiertos:

- Ver propuestas aplicadas; dependencias pendientes y volver; antes/después y cálculo de la comparación; solo cambios/todos; antecedentes de una propuesta; abrir/cerrar regla y explicación; revisión y decisiones de conflicto.
- Selección múltiple de propuestas, selección del ámbito filtrado, limpieza global, revisión paginada y aceptación de aplicación. No confundir selección con consentimiento para modificar importes.
- Aceptación de hojas excluidas, elecciones de productor/omisión y confirmaciones con efecto sobre una publicación.
- Existe una duplicación de «Volver» cuando se consultan dependencias pendientes; evitar acciones duplicadas y controles sin contenido asociado.

Ubicaciones: componentes de `apps/web/src/app/import/`, `validation/`, `recalculation/`, `workspace/workspace-shell.component.html` y `shared/calculation-detail.component.html`. El plan deberá vincular cada fila del inventario a sus casos, sin limitar la revisión a los controles visibles en las capturas del usuario.

## Descarga: hechos y causa todavía no demostrada

**Hechos de código:** selector y encabezado de Descargar usan la misma elección de versión; la carga del resumen ya descarta respuestas de otra versión. A la vez, el acceso de informes aplicados usa la versión del recibo, la comparación ofrece su propia descarga y la repetición puede recuperar un artefacto previamente preparado. Existen, por tanto, varias intenciones de descarga que pueden coexistir con la elección visible.

**Síntoma comunicado:** versión 1 seleccionada frente a un resumen de versión 6. La causa concreta de esa diferencia visual todavía no está reproducida en esta fase. Una hipótesis de exploración es el momento en que el selector nativo recibe su valor respecto a la aparición de opciones; no se presenta como diagnóstico confirmado ni se prescribe un arreglo.

**Resultado requerido:** coincidencia de selección visible, resumen, solicitud y archivo en versión, contenido y ejecución. Históricos elegidos voluntariamente deben seguir disponibles; forzar siempre la última versión no resolvería el requisito. Cambiar cualquier parte de la elección no debe permitir descargar silenciosamente un artefacto anterior incompatible.

Referencias: `apps/web/src/app/recalculation/exports.component.html`, `exports.component.ts`, `export.store.ts`, `comparison.component.html` y `apps/web/src/app/core/session.store.ts`.

## Preparación de Vercel: restricciones oficiales

El backend actual está configurado para uso local: un token de sesión y almacén del proceso compartidos por su arranque, entrega del token mediante bootstrap y restricciones de acceso local. El estado reside en mapas del proceso; los trabajos se ejecutan en workers y los archivos usan almacenamiento temporal. Esa composición no acredita sesiones independientes entre visitantes ni continuidad entre instancias. Referencias de la exploración: `apps/api/src/app.ts` (configuración de sesión y almacén, líneas 61–75), `routes/bootstrap.ts`, `plugins/local-session.ts`, `session/workspace-store.ts` y `jobs/job-manager.ts`, todos bajo `apps/api/src/`. Preparar la demo exige resolver estas diferencias, no solo añadir configuración de despliegue.

Fuentes oficiales consultadas el 2026-11-08. Son restricciones para el plan, no una elección de proveedor ni evidencia de un despliegue realizado.

| Fuente | Hallazgo | Consecuencia pendiente de diseño |
| --- | --- | --- |
| [Límites de Functions](https://vercel.com/docs/functions/limitations) | El cuerpo de petición o respuesta de una Function está limitado a 4,5 MB. | No basta trasladar la carga y descarga actuales sin comprobar archivos de 10 MiB y paquetes grandes; no reducir los límites del producto para ocultar la incompatibilidad. |
| [Runtimes de Functions](https://vercel.com/docs/functions/runtimes) | Sistema de archivos de solo lectura salvo espacio temporal `/tmp`, con límite documentado de 500 MB. | Los originales, resultados y estado que deban continuar no pueden considerarse persistentes por existir en un directorio temporal. |
| [Fastify en Vercel](https://vercel.com/docs/frameworks/backend/fastify) | Una aplicación Fastify se despliega como una Function y queda sujeta a sus límites. | Comprobar el conjunto del recorrido, sus cuotas y trabajos, no solo la respuesta de una ruta. |
| [Trabajo después de responder](https://vercel.com/kb/guide/troubleshooting-inconsistent-logs-in-vercel-functions) | Trabajo no esperado puede quedar congelado tras la respuesta; extender su ejecución no sustituye la persistencia. | Los trabajos aceptados necesitan continuidad, estado y resultado recuperables; no asumir que responder «aceptado» garantiza su finalización. |
| [Carga directa desde cliente](https://vercel.com/docs/vercel-blob/client-upload) y [URLs firmadas](https://vercel.com/docs/vercel-blob/vercel-signed-urls) | Existen mecanismos oficiales de transferencia directa y acceso autorizado a archivos privados. | Son alternativas que el plan puede evaluar; esta fase no elige Vercel Blob ni contrata almacenamiento. |
| [Configurar CORS](https://vercel.com/kb/guide/how-to-enable-cors) | Acceso entre orígenes y peticiones de comprobación previa necesitan configuración explícita. | Probar orígenes autorizados, cabeceras y sesión entre frontend y backend separados; permitir orígenes no resuelve persistencia o aislamiento. |
| [Excepciones OPTIONS de protección](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/options-allowlist) | La protección de despliegues puede afectar a la comprobación previa; permitir OPTIONS no elimina la protección de la petición real. | Distinguir funcionamiento local, preview protegida y alojamiento previsto; no debilitar protección sin decisión explícita. |

El estado de sesión actual no tiene los nuevos plazos globales de caducidad. La caducidad de inspecciones/revisiones y los límites de trabajos no sustituyen una política de sesión pública. Se adoptan para especificar 60 minutos de inactividad significativa, 24 horas absolutas y limpieza hasta 24 horas después de revocar, con cuotas públicas finitas a concretar en el plan.

El plan debe resolver continuidad entre instancias, aislamiento anónimo, originales, trabajos, versiones, atomicidad e idempotencia; definir servicios, costes, secretos, límites y limpieza; y separar evidencia local de la comprobación real. Sin entorno autorizado puede entregarse preparación documentada, pero no declarar el alojamiento verificado. No se han creado cuentas, contratado servicios ni publicado proyectos en esta fase.

La verificación local deberá usar dos orígenes distintos y cubrir carga, seguimiento, escrituras, descarga, errores, comprobaciones previas y rechazo de un origen ajeno; también acceso directo y recarga de rutas del frontend. Producción y previews requieren autorizaciones explícitas, sin un comodín para todos los dominios de Vercel, y los secretos del backend no deben quedar en el frontend. Las cabeceras de sesión, concurrencia e idempotencia forman parte de esa comprobación; la configuración concreta corresponde al plan.

## Límites de la evidencia

- La comprobación de 004 y su benchmark describen el código anterior; no acreditan los cambios de 005.
- El inventario y las referencias proceden de exploración de fuentes. El desajuste de versiones conserva una causa pendiente de reproducción.
- La especificación mantiene COREP, FINREP F 01.01 y reglas tipadas como regresiones; no amplía conformidad regulatoria ni modifica originales.
- Las fases posteriores realizarán implementación, pruebas y capturas de la interfaz final, y la comprobación de alojamiento cuando exista un entorno autorizado; README se actualizará al final, reflejando tanto lo comprobado como cualquier verificación real pendiente.
