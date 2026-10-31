# ConsolidationEngine

Aplicación local para validar informes regulatorios Excel con reglas EBA, explicar los resultados
y proponer recálculos con dependencias. Angular presenta los datos; Node.js ejecuta el motor con
ANTLR, aritmética exacta y ordenamiento topológico de Kahn. Los cambios requieren elegir destinos,
revisar propuestas y confirmarlos; la aplicación conserva las versiones anteriores y revalida.

Las funcionalidades US1–US4, recursos y rendimiento tienen evidencia técnica en
[verificación](docs/verification.md). El ensayo de uso con una persona analista **SC-007 sigue
pendiente**: los recorridos automáticos y las comprobaciones de accesibilidad no lo sustituyen.
La verificación final consolidada se registra por separado; aquí no se fija un total global de pruebas.

## Instalación y arranque

Desde la raíz del repositorio, en PowerShell de Windows x64, con Java 11 o superior disponible
mediante `java` (la generación registrada usa Java 17):

```powershell
.\scripts\bootstrap-toolchain.ps1
.\scripts\run-with-toolchain.ps1 -NpmArguments @('ci')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'build')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('start')
```

El bootstrap prepara Node 24.22.2/npm 11.19.1 en `.tools/`, sin cambiar las instalaciones globales.
La primera preparación descarga dependencias y el JAR ANTLR verificado. Build genera el parser,
compila API y Angular. Después de iniciar, abrir `http://127.0.0.1:3000`; ese proceso sirve web y
API. Para detenerlo, usar Ctrl+C en su terminal.

Para desarrollo, detener antes el servidor anterior y ejecutar:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'dev')
```

Abrir `http://127.0.0.1:4200`. Angular recarga los cambios del frontend; los cambios del backend
requieren reiniciar el comando. Los detalles del toolchain y las pruebas están en
[scripts/README.md](scripts/README.md) y [quickstart](specs/001-regulatory-validation/quickstart.md).

## Ejemplo guiado en ocho pasos

Los dos archivos del ejemplo contienen reglas y datos **100 % sintéticos**. Se usan tal como se
descargan, sin editar Excel. Ambos incluyen una hoja Instructions. Desplegar la guía o descargar
los archivos no importa datos ni aplica cambios.

1. Introducir un **Nombre del conjunto** y pulsar **Crear conjunto**. En Cargar, desplegar
   **Empezar con el ejemplo guiado** y descargar el catálogo y el informe. Seleccionar
   `ejemplo-catalogo.xlsx` como catálogo y `ejemplo-informe.xlsx` como informe y cargarlos manualmente.
   Una carga válida sustituye los archivos del conjunto si ya contenía otros datos.
2. Pulsar **Validar informes**: `SYNTHETIC_A` falla y `SYNTHETIC_D` pasa. Los valores son
   A=11, B=5, C=7 y D=22; las reglas son A=B+C y D=A×2.
3. En **Configurar destinos de recálculo**, elegir **Izquierda** en ambas reglas y pulsar
   **Guardar configuración**. Los valores todavía no cambian.
4. Pulsar **Simular recálculos**: las propuestas son A=12.00 y D=24.00; D utiliza el A propuesto.
5. Seleccionar primero `SYNTHETIC_D` para ver que requiere `SYNTHETIC_A`. Seleccionar también A
   expresamente; el sistema informa la dependencia y espera esa selección.
6. Revisar ambos cambios, marcar la confirmación **He revisado cada propuesta…** y pulsar
   **Aplicar cambios seleccionados**. Se publica una nueva versión después de revalidarla.
7. Comprobar la comparación: antes, una regla pasa y otra falla; después, **dos pasan y ninguna
   falla**. A cambia de 11 a 12.00 y D de 22 a 24.00; B y C permanecen en 5 y 7.
8. En **Guardar informes y resultados**, elegir explícitamente la versión marcada **vigente**,
   el contenido **Informes y registro de cambios** y pulsar **Preparar y descargar ZIP**.
   El panel conserva su selección histórica hasta que se cambie.

`report.zip` contiene un ce-report-1 por informe original y `changes.json`/`changes.xlsx` con la
auditoría acumulada de esa versión. Para reimportar, extraer los informes y cargarlos con el
catálogo original por separado. **Resultados de validación** exporta `results.json` y `results.xlsx`
de la ejecución elegida. Las descargas ya guardadas permanecen al cerrar el conjunto.

## Datos, límites y sesión

- Una entidad/fecha por conjunto; hasta 500 filas de catálogo, 20 informes y 100.000 hechos y
  coordenadas. Máximo 10 MiB por archivo, 50 MiB comprimidos por lote y 100 MiB descomprimidos.
- Plantilla ce-report-1 con Instructions, Contexts, Coordinates y Facts. Códigos e importes se
  guardan como texto; cero, null explícito y ausencia se distinguen. Los indicadores de presentación
  se declaran expresamente. Los errores explican archivo, hoja y celda sin revelar rutas internas.
- Perfil `ce-dpmxl-0.9-closed-v1`: subconjunto explícito de DPM-XL, con precisión e intervalos
  cuando se solicitan. Las construcciones no soportadas son no evaluables. El perfil documenta
  una diferencia frente a las fórmulas inconsistentes de multiplicación/división de intervalos
  observadas en el PDF EBA v0.9; no afirma conformidad literal completa.
- Una tarea activa, cancelación y plazo de 60 segundos de trabajo; recepción de archivos hasta
  120 segundos. Las cuotas adicionales se muestran en capacidades y están en los contratos.
  Un fallo o cancelación anterior a publicar conserva la versión vigente; cancelar después no deshace
  una aplicación ya publicada. Una aceptación sin cambio de valor queda auditada con `changed:false`.
- Sesión local y efímera: se recupera al refrescar el navegador, pero termina al cerrar el conjunto
  o reiniciar el servidor. Se conservan hasta 20 snapshots, con cuotas separadas de 512 MiB para
  estado canónico y archivos propios. Las exportaciones guardadas por el usuario sobreviven al cierre.

El benchmark sintético de 500 reglas distintas y 100.000 hechos produjo **10/10 ejecuciones ≤30 s**,
con máximo **16,320 s**, en Ryzen 5 3600X/32 GiB y Windows 11. Mide desde fin de carga hasta resultados
visibles; la carga está excluida. El [informe de rendimiento](docs/performance.md) conserva protocolo,
auditoría y límites de esa evidencia; no es una garantía para cualquier equipo o conjunto de reglas.

## Documentos y desarrollo

- [Guía de uso y verificación](specs/001-regulatory-validation/quickstart.md): comandos, V01–V16 y SC-007 pendiente.
- [Verificación por incrementos](docs/verification.md) y [rendimiento](docs/performance.md).
- [Toolchain y scripts](scripts/README.md): versiones aisladas, generación y pruebas.
- [Especificación](specs/001-regulatory-validation/spec.md), [plan](specs/001-regulatory-validation/plan.md)
  y [tareas](specs/001-regulatory-validation/tasks.md).
- [Investigación](specs/001-regulatory-validation/research.md) y [modelo de datos](specs/001-regulatory-validation/data-model.md).
- Contratos de [HTTP](specs/001-regulatory-validation/contracts/http-api.md),
  [Excel](specs/001-regulatory-validation/contracts/workbook.md) y
  [lenguaje/cálculo](specs/001-regulatory-validation/contracts/language-profile.md).
- [Constitución](.specify/memory/constitution.md) y [fuentes originales](specs/001-regulatory-validation/source-notes.md).

Spec Kit organiza el trabajo y Git conserva commits por funcionalidades verificadas. Los originales
EBA, gramáticas y PDF permanecen intactos; la generación usa copias con nombres compatibles y hashes
comprobados. Las cargas, temporales, descargas y credenciales locales no se incorporan al repositorio.
La revisión por recibos permanece `disabled/unmanaged`; los checklists de Spec Kit son documentales.
