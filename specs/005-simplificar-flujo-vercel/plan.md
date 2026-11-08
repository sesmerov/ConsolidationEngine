# Implementation Plan: Flujo sencillo y demo pública independiente

**Branch**: `codex/005-simplificar-flujo-vercel` | **Date**: 2026-11-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/005-simplificar-flujo-vercel/spec.md`

## Summary

Simplificar las cuatro etapas conservando exactitud y consentimiento: corregir foco/halo, mover destinos al inicio de Recalcular con decisiones pendientes, simular mediante una única publicación atómica y centralizar la descarga en una intención y un botón. Una identidad de base de validación separada de la versión de configuración evita revalidaciones y versiones por navegación.

Preparar dos proyectos Vercel con prioridad explícita a planes gratuitos: Angular estático; backend Node con Neon Free como autoridad transaccional, QStash Free para entrega durable y mantenimiento, y Blob privado para archivos y bloques inmutables. Sesiones anónimas por petición, fragmentos autenticados y cuotas públicas finitas sustituyen las suposiciones de proceso único del modo local, que permanece disponible. No se publica ni contrata durante esta fase; capacidad y alojamiento real siguen pendientes de evidencia.

Phase0 documentada primero en [research.md](research.md); Phase1 en [data-model.md](data-model.md), [contratos](contracts/api.md) y [quickstart.md](quickstart.md). README será la última tarea funcional de implementación, después de pruebas y capturas finales, e indicará desarrollo mediante SDD con Spec Kit.

## Technical Context

**Language/Version**: TypeScript 6.0.3; Node local 24.22.2/npm 11.19.1; Node 24.x en Vercel con minor/patch administrados por proveedor y registrados en evidencia; Java ≥ 11 en build, ANTLR herramienta/runtime 4.13.2 y JavaScript generado reproducible.

**Primary Dependencies**: Angular/Material 22.2.4, CLI 22.2.5, Fastify 5.12.7 existentes; nuevos pins backend `pg` 8.23.1, `@types/pg` 8.23.1, `@vercel/blob` 2.8.2 y `@upstash/qstash` 2.12.1. Sin instalación ni actualización durante plan. Angular usa Forms públicas, sin DOM privado de Material.

**Storage**: Adaptador local memoria/archivos conservado. Hosted: PostgreSQL Neon Free para metadatos, índices, revisiones, transacciones, outbox y cuotas; Blob privado para originales y bloques canónicos compartidos dentro de sesión. No filas JSON de sesión entera ni referencias entre visitantes.

**Testing**: Vitest 5.0.5, Angular tests y Playwright 1.64.1; PostgreSQL 17 real aislado y dos instancias/orígenes; cola/objetos controlados con fallos reproducibles; paquete Linux y medición de RSS/tmp. Prueba real de proveedores solo con entorno autorizado. Nuevos scripts previstos en quickstart; no resultados nuevos atribuidos a este plan.

**Target Platform**: Local Windows/Linux y preparación Vercel Hobby Fluid 2 GB/1 CPU. Dos proyectos con raíces `apps/web` y `apps/api`; frontend estático y backend Node Function explícita, sin iniciar listener local en alojamiento.

**Project Type**: Monorepo de aplicación web Angular, servicio Node y motor puro compartido; adaptadores de infraestructura separados del cálculo.

**Performance Goals**: Conservar búsqueda ≤ 1 s y protocolo de validación existente cuando corresponda revalidarlo. Job ≤ 60 s desde primer claim incluyendo I/O y publicación; cola ≤ 10 min; callback ≤ 120 s. Gate propuesto para el peor caso alojado: RSS agregado ≤ 1,6 GiB y /tmp ≤ 400 MiB, no medidas realizadas. UI paginada ≤ 50 filas y JSON ≤ 1 MiB real; binario ≤ 3 MiB por respuesta/petición.

**Constraints**: Angular/Node/ANTLR JavaScript/Kahn, exactitud decimal, originales intactos, solo validación de condicional/texto/fecha/desigualdad y aceptación explícita de aplicación. Entradas 10 MiB por archivo/50 MiB por lote/100 MiB expandido, ZIP 100 MiB final; 512 MiB de estado y 512 MiB de archivos por sesión separados, 20 snapshots. Sesión 60 min inactiva/24 h absoluta y limpieza ≤ 24 h. No secretos proveedor ni datos de negocio persistidos en navegador.

**Scale/Scope**: Demo sintética anónima; 4 sesiones activas, 10 creaciones/día, 1 CPU global/por conjunto, 8 jobs en cola, 30 jobs/día y 120/30 días. Límites globales y presupuesto de mantenimiento en [deployment.md](contracts/deployment.md). Son admisión configurada, no capacidad demostrada. Sin cuentas/SSO, informes reales, compra automática o ampliación de cobertura EBA.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principio | Antes de investigación | Después del diseño |
| --- | --- | --- |
| I. Semántica y cobertura honesta | No ampliar lenguaje o perfiles. | Motor conserva semántica; DTO compacto no trunca valores ni convierte límites de transporte en «no soportado»; fuentes originales se verifican. |
| II. Reproducibilidad | Conservar pins, bases y exactitud. | Base inmutable separada de configuración; bloques versionados, cantidades como cadenas y hashes; Java/Node efectivos registrados, ANTLR ocho archivos comparados. |
| III. Recálculos controlados | Automatizar solo decisiones inequívocas, no aplicar. | Configurar-y-simular en un job y una publicación; aplicación mantiene confirmación/CAS/atomicidad y revalidación. Cancelar/fallar deja datos y versión previos. |
| IV. Dependencias verificables | Kahn y conflictos permanecen. | Omisión explícita de pendientes, selección/dependencias y ramas independientes conservadas; ningún ganador silencioso. |
| V. Evidencia incremental | Plan documental, sin pruebas inventadas. | Gates locales/paquete/capacidad/reales separados; próximos commits acotados por funcionalidad; README al final; aceptación humana004 pendiente. |
| Datos locales y autorización | Usuario autoriza demo pública solo sintética. | Excepción de alcance expresa; modo local intacto, sesión privada y aviso sin presumir detección de datos reales. |

Resultado de ambas revisiones: **diseño compatible, sin violaciones no justificadas**. Esto no acredita que los gates de implementación/capacidad/alojamiento hayan pasado. Receipt-driven development permanece `disabled/unmanaged`; no se habilitan revisiones automáticas.

## Project Structure

### Documentation (this feature)

```text
specs/005-simplificar-flujo-vercel/
├── spec.md
├── evidence.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/requirements.md
└── contracts/
    ├── ui.md
    ├── api.md
    └── deployment.md
```

`tasks.md` corresponde a la siguiente fase y no se crea aquí.

### Source Code (repository root)

```text
apps/web/src/app/
├── core/                  # Conexión, sesión, cliente API, foco y guías
├── workspace/             # Navegación y contexto
├── import/                # Adaptador de carga por fragmentos
├── validation/            # Cumplimiento y navegación a descarga
├── recalculation/         # Destinos, simulación, selección, descargaFSM
└── shared/                # Detalles útiles y valores paginados
apps/api/
├── api/index.ts           # NUEVO: entrada Node Function
├── src/hosted-entry.ts    # NUEVO: montaje alojado sin listener
├── src/{routes,plugins}/  # Contexto privado por petición, CORS, contratos
├── src/{session,jobs,storage,workers,recalculation,export}/
└── src/hosted/            # NUEVO: repositorioSQL, objetos, cola, codec, ledger
packages/contracts/src/   # DTOcompactos, sesiones, transferencias y operaciones
packages/engine/src/      # Base de validación y funciones puras reutilizadas
scripts/                  # Packaging, entornos aislados y verificación
 tests/{contract,integration,e2e,performance}/
```

**Structure Decision**: Mantener monorepo y motor existente. Introducir puertos de repositorio, archivos y despacho con adaptadores locales y alojados; reemplazar closures de publicación persistidas por comandos/referencias explícitos. Servicios y pools reutilizables por proceso no almacenan identidad del visitante; cada petición consulta sesión viva y propietario. Consultas paginadas usan índices pequeños; solo worker rehidrata su entrada.

## Secuencia de implementación prevista

1. Contratos y pruebas rojas de identidad de base, decisiones, operación compuesta, selección de descarga y transporte acotado; no escribir tests que solo repitan implementación.
2. UX local: foco/halo, destinos al inicio de Recalcular, publicación atómica y único botón; inventario 17 selectores/11 desplegables y controles relacionados con casos de teclado/históricos/errores.
3. Adaptadores y durabilidad: esquema SQL/codec/referencias, sesión anónima, outbox/fences, worker esperado, cuotas y limpieza; conservar adaptador local y rutas compatibles.
4. Fragmentos privados de entrada/salida, originales retenidos FINREP y DTO compactos/valores grandes; probar pérdida de respuesta, propietario y límites antes de conectar proveedores.
5. Configuraciones de los dos proyectos, bundleLinux y capacidad en baseline gratuito; pruebas locales obligatorias con dos orígenes/instancias. Verificaciónreal solo tras provisión autorizada, registrada aparte.
6. Regresiones guiadas COREP/FINREP/tipos, inventario final y capturas reales de cuatro etapas; **README como último trabajo funcional** con SDD/Spec Kit, diagramas, setup, cuotas y límites honestos.

La generación de tareas deberá vincular FR001–030 y SC001–010 a estas etapas y contratos. No se cuentan pruebas aún inexistentes ni se marca la aceptación humana de 004.

## Validation and delivery gates

| Gate futuro | Evidencia requerida |
| --- | --- |
| UX y decisiones | SC001–005, tres anchuras, modalidades de foco, diez reentradas sin versiones y publicación compuesta atómica. |
| Dominio y archivos | SC009, valores guiados, solo validación tipada, Kahn, bytehash/export-reimport y preservación de originales. |
| Hosted local | SC006–008, PostgreSQL real, dos visitantes/instancias/orígenes, duplicados y fallos de publicación, caducidad/limpieza sin navegador. |
| Payload y capacidad | JSON 1 MiB/partes 3 MiB, entradas y ZIP máximos con overhead, 20 snapshots compartidos, RSS/tmp/deadline; ningún límite reducido para aprobar. |
| Packaging y Vercel | Build Linux aislado, versión Node/Java efectiva, parser/worker/assets; alojamiento real pendiente si faltan recursos. Configuraciones solas no son PASS. |
| Documentación final | SC010: introducción < 10 líneas, SDD con Spec Kit+enlace a specs/, dos diagramas Mermaid y cuatro capturas versionadas portables después del producto. |

Fuentes, decisiones y alternativas están en research; contratos son la referencia normativa. No hay hooks de extensión registrados. Los artefactos de esta fase constituyen un plan revisable, no un despliegue ni una promesa de gratuidad/disponibilidad.

## Complexity Tracking

No hay violaciones constitucionales que requieran excepción técnica adicional. La autoridad SQL, cola durable y almacenamiento privado son necesarios para sesiones independientes, continuidad y archivos dentro de los límites elegidos. Se descartan sesión global, disco temporal como persistencia y tareas abandonadas tras responder; el modo local simple continúa disponible. La excepción de enviar exclusivamente datos sintéticos a la demo está autorizada expresamente por el usuario.
