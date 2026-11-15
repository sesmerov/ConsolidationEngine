# Guía de validación — 005

Esta guía permite repetir la comprobación de la implementación. Los comandos están disponibles; sus resultados y límites se registran en [verification-005.md](../../docs/verification-005.md). Las pruebas locales con adaptadores controlados no acreditan un despliegue real en Vercel.

## Preparación local

1. Checkout del proyecto, Node 24.22.2/npm 11.19.1 y Java ≥ 11 según herramientas fijadas. Conservar originales EBA, manifiestos y hashes. Para comprobar empaquetado Vercel, disponer también de entorno Linux aislado.
2. PostgreSQL 17 real de pruebas, separado de datos de usuario: Docker autorizado o `TEST_DATABASE_URL` proporcionada. Que `docker.exe` exista no demuestra que funcione su daemon; comprobarlo antes. No se necesita contratar Neon para integración local.
3. Claves de prueba independientes, incluida `CE_CURSOR_SIGNING_KEY` compartida por ambas instancias; fixtures de firma QStash y almacén privado controlado. Nunca usar secretos de producción ni guardarlos en Git, capturas o logs.
4. El arnés hosted usa3350 frontend,3351 origen API balanceado,3352/3353 instancias API y3354 control de prueba. El navegador local usa3318; el benchmark3317. Cada arnés comprueba propiedad y cierra sus recursos; no reutilizar ni cerrar el servidor del usuario en3340.

Comandos de construcción y comprobación local (con la herramienta aislada instalada):

```powershell
& scripts/run-with-toolchain.ps1 -NpmArguments @('ci')
& scripts/run-with-toolchain.ps1 -NpmArguments @('run','build')
& scripts/run-with-toolchain.ps1 -NpmArguments @('run','typecheck')
& scripts/run-with-toolchain.ps1 -NpmArguments @('test')
```

Comandos de integración y empaquetado disponibles:

| Comando | Qué comprueba |
| --- | --- |
| `npm run test:hosted` | Crear esquema SQL aislado, cola/objetos controlados y dos instancias; ejecutar integración y contratos, cerrar únicamente recursos propios. Sin servicios comerciales. |
| `npm run test:e2e:hosted` | Frontend/API en orígenes distintos; Chromium con dos visitantes y escenarios del flujo. |
| `npm run package:vercel:web` / `package:vercel:api` | Producir los artefactos aislados del contrato de despliegue, sin publicar. |
| `npm run test:package:linux` | Verificar Node/Java efectivos, ocho generados, workers/ANTLR/assets y ejecución sin archivos del checkout original. |
| `npm run test:capacity:hosted` | Medir casos máximos, RSS agregado, temporales, cuotas, cancelación y deadline; guardar entradas, hashes, entorno y resultados sin ocultar fallos. |

Las suites locales prueban memoria/archivos; `test:hosted` utiliza PostgreSQL real para acreditar transacciones. Los adaptadores controlados de QStash/Blob reproducen pérdidas, duplicados y carreras sin contactar con proveedores. Docker Desktop debe estar operativo; las imágenes fijadas por digest deben estar presentes (el arnés SQL usa `--pull=never`).

Para la búsqueda: `npm run test:e2e -- tests/e2e/catalog-search.spec.ts`. Para el benchmark local: `npm run bench -- --prepare .cache/benchmark/005-reference`, después `--pilot` y `--cohort` con ese directorio; usar uno nuevo si la referencia ya existe. El criterio exige diez ejecuciones auditadas, nueve≤30s y todas≤60s. No ejecutar otros arneses pesados a la vez. La medida de capacidad alojada se realiza aparte mediante `test:capacity:hosted`.

## A. Foco y guía visual

En 320/390/1440 px: navegar con ratón y luego Tab/Enter; abrir «Ver informes y contexto», enfocar un error y alternar modalidad. Título/cabecera no muestran el rectángulo innecesario tras ratón; teclado y errores conservan indicador. Halo coincide con caja/radio del botón completo y no desplaza contenido. Comprobar 4,5 s, movimiento reducido y colores forzados. Hitos: carga→Validar; validación completa vigente→Recalcular; aplicación→Descargar. No aparecen «Siguiente paso» ni avances por históricos/fallos.

## B. Destinos, base y simulación atómica

1. Completar carga/validación COREP; entrar directamente en Recalcular y comprobar título exacto, destinos inequívocos automáticos y solo decisiones pendientes.
2. En el recorrido guiado COREP elegir `v0174_m` para fila 0070 y omitir fila 0200; comprobar que no quedan pendientes. En un caso `A=B` elegir lado u omitir; en grupos de 2, 3 y 51 productores comprobar páginas, editor y omisiones.
3. Entrar/recargar diez veces: mismos datos y versión, elecciones conservadas. Cambiar solo configuración mantiene base de validación y no exige validar otra vez.
4. Simular una vez publica configuración cambiada, preview y selección inicial juntos. Consultar de nuevo conserva la revisión confirmada; «Revisar destinos» inicia otra revisión de forma explícita. Interrumpir antes del commit: versión/importes intactos y borrador conservado. Perder respuesta tras commit y repetir clave: mismo recibo/IDs, sin otra versión.
5. Cambiar datos invalida ejecución/revisión; un histórico seleccionado en Validar no sirve para otra base. Sin ejecución compatible, ir a Validar; sin candidatos, ir a Descargar sin configuración vacía.
6. Selección y aplicación mantienen dependencias fuera de página, reintento idéntico y consentimiento invalidado al editar; condicionales/texto/fecha/desigualdades no ofrecen recálculo.

## C. Una descarga coherente

Probar todos los contenidos actuales. Verificar DOM de versión, estado del componente, resumen, solicitud, manifiesto y bytes finales. Incluir versión 1 seleccionada frente a artefacto 6, opciones que llegan tarde, histórico voluntario después de aplicar, cambio de intención durante job, aceptación incierta, recarga, fallo/caducidad y cancelación.

Un solo botón prepara/descarga/reintenta; Cancelar separado. No descarga directa desde Validar o Recalcular: la primera navega con intención y la comparación no exporta. Resultados requieren ejecución de **esa versión exacta**, aunque otra comparta base; elegir original o validar explícitamente si se quieren resultados de una versión solo de configuración. Esto no bloquea Simular.

Fallos de transferencia reintentan el artefacto existente; una respuesta tardía de otra intención nunca cambia selección ni provoca su descarga. Texto original grande y lecturas completas siguen accesibles mediante páginas/fragmentos, sin arrays globales o JSON mayor de 1 MiB.

## D. Dos visitantes y dos instancias

Abrir contextos de navegador A/B sin compartir sessionStorage. Crear tokens/nonce antes del POST; perder su respuesta y repetir: misma sesión. Reusar nonce con otro token o token con otro nonce: conflicto; repetir una sesión cerrada no la revive. Los secretos no aparecen en URLs/logs.

Alternar peticiones autenticadas de la misma sesión entre3352/3353 a través del origen3351 manteniendo el mismo perfil público; ambas comparten PostgreSQL, objetos y clave de cursor. No cambiar baseURL de la aplicación para simular una instancia, pues eso deliberadamente cambia su namespace de sesión. Probar conjunto, trabajo, parte, histórico, explicación, contexto, cursor y descarga ajenos: sin acceso ni filtración de existencia. Recargar la pestaña conserva trabajo vigente.

Con dos orígenes autorizados comprobar preflight y petición real de lectura, POST/PATCH, fragmento, polling, error y descarga; rechazar un tercer origen. No usar cookies de terceros ni bypass secreto en frontend. Abrir/recargar directamente rutas del frontend sin404 y sin ocultar404 de assets inexistentes.

## E. Durabilidad, plazos y limpieza

- Caídas entre transacción/outbox, envío/acuse, claim/worker, objetos/commit y commit/respuesta; duplicados concurrentes. Envío incierto devuelve503 recuperable, no202 falso. Mismo fingerprint recupera antes de evaluar una base ya antigua; otro409.
- Un job CPU global y por conjunto; cola 10 min, trabajo 60 s desde primer claim incluyendo I/O/publicación. Duplicado no inicia otro worker; intento iniciado perdido no reinicia tiempo. Fence antiguo no publica; permiso huérfano no se recicla antes de 120 s salvo terminación acreditada.
- Cancelación observada durante worker; carrera con cierre, caducidad y cambio de base. Ninguna publicación tardía; datos anteriores intactos. Detener las pestañas y seguir mantenimiento horario.
- Reloj controlado para 60 min inactivo/24 h absoluto; GET, recarga, foco, polling y fragmentos no renuevan. Aviso oportuno, revocación inmediata y limpieza ≤ 24 h de originales, partes, bloques, artefactos y huérfanos. Reintentos con fallos controlados y reserva de mantenimiento aun con admisión agotada.

## F. Capacidad y perfiles

Archivos válidos mayores de 4,5 MB y hasta 10 MiB; lote50 MiB, expansión100 MiB y cada límite+ 1. Exportación ZIP grande hasta 100 MiB final con 34 partes: tamaños/hashes completos, overhead, orden y corrupción; no emitir manifiesto parcial. Original FINREP reconstruido y verificado tras inspección/confirmación y entre instancias, sin pérdida por limpieza de staging.

Medir veinte snapshots compartidos y el peor caso admitido, lecturas API concurrentes y cancelación: objetivoRSS agregado ≤ 1,6 GiB y `/tmp` ≤ 400 MiB con 2 GB/1 CPU. No comparar heap del worker con RSS del proceso ni usar solo la demo pequeña como evidencia. Fallar exige optimización o registrar incompatibilidad, no reducir límites o contratar upgrades.

Regresiones guiadas: COREP 7/8/1→14/1/1 con sus cinco recálculos previstos; FINREP 38 posiciones, 2/3→4/1,90→100 y 105→120, explicación 100+ 20= 120 y descarga/reimportación; texto/fecha6/2 y ningún recálculo. Verificar originales/manifiestos inmutables. Las pruebas de volumen y benchmark existentes se repiten solo donde el cambio lo justifique, conservando protocolo y evidencia sin atribuir nuevas cifras todavía.

## G. Comprobación real y cierre documental

Solo tras autorización y provisión, contrastar configuración contra cuotas vigentes de Hobby/Neon/QStash/Blob, variables y costes compartidos; publicar y probar dos proyectos, versiones efectivas Node/Java, rutas, firmas, instancias, CORS/previews, archivos grandes y limpieza. Registrar permisos/servicios que falten como **alojamiento real pendiente**, nunca como prueba aprobada ni como servicio a contratar automáticamente.

Después del producto estable y sus verificaciones, capturar las cuatro etapas con datos sintéticos, versionar imágenes portables y actualizar README como último trabajo funcional: introducción < 10 líneas, SDD mediante Spec Kit enlazado a `specs/`, tecnologías/setup, dos diagramas Mermaid, alcance y evidencia local/real pendiente. La aceptación humana SC-010 de 004 sigue independiente. Las pruebas ejecutadas están en verification-005.md; esta guía no declara aceptación humana.
