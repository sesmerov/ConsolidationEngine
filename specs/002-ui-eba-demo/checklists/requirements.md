# Specification Quality Checklist: Interfaz clara, plantillas COREP y demo verificable

**Purpose**: Validar la calidad y la completitud de los requisitos antes de la planificación.

**Created**: 2026-11-04

**Feature**: [spec.md](../spec.md)

**Estado**: Comprobación de redacción de la especificación; no acredita implementación, pruebas ejecutadas ni aceptación del usuario.

## Content Quality

- [x] Sin decisiones de implementación internas; las tecnologías aparecen únicamente como restricciones expresas del usuario y continuidad del proyecto.
- [x] Centrada en valor para el usuario y necesidades de negocio.
- [x] Redactada para explicar comportamiento observable al analista.
- [x] Todas las secciones obligatorias están completas.

## Requirement Completeness

- [x] No quedan marcadores de aclaración pendientes.
- [x] Los requisitos son comprobables y no ambiguos dentro del perfil delimitado.
- [x] Los criterios de éxito son medibles.
- [x] Los criterios de éxito no dependen de una implementación concreta.
- [x] Los escenarios de aceptación están definidos.
- [x] Los casos límite están identificados.
- [x] El alcance está delimitado: COREP 4.0 C_01.00 y complemento sintético de tipos, sin cobertura general COREP/FINREP.
- [x] Se identifican dependencias, supuestos y decisiones que debe cerrar la planificación.

## Feature Readiness

- [x] Los requisitos funcionales tienen escenarios y criterios de aceptación observables.
- [x] Las historias cubren lectura, importación, demostración, recálculo y exportación.
- [x] Los resultados medibles corresponden a las necesidades descritas.
- [x] No se introducen decisiones de arquitectura en los requisitos; se conserva la restricción tecnológica explícita del usuario.

## Notes

- Aclaración del usuario incorporada el 2026-11-04: condicionales, texto y fechas son exclusivamente de validación, también si producen números o aparecen en precondiciones formales. FR-028/029, US3 y SC-006 cubren presentación, rechazo en el servicio y ausencia de propuestas; no se confunden con metadatos administrativos.
- Coherencia tras planificación: el perfil ampliado limita recálculos a numéricos; el anterior conserva sus booleanos existentes sin admitir construcciones nuevas. Se mantiene orden del servidor y paginación, sin añadir ordenación interactiva. Los criterios de esta lista siguen siendo documentales.

- Angular Material, ANTLR, Node.js, Angular y Kahn son restricciones solicitadas o ya establecidas, no decisiones nuevas inferidas por esta especificación. Se aíslan de los criterios de éxito.
- La cobertura de plantillas se limita a CA1/C_01.00 de la fuente identificada. La planificación concretará el manifiesto de reconocimiento, tipos y correspondencias y la política para las hojas, fórmulas y referencias externas fuera de cobertura.
- La matriz de las al menos 24 reglas será un requisito previo a implementar la demo. No se presenta como un resultado ya obtenido; «funcionan» significa que coinciden con expectativas conocidas, incluidos fallos intencionados.
- La incorporación de fechas, textos y condicionales es una ampliación real del perfil semántico, pendiente de implementación y prueba; el reconocimiento por la gramática actual no constituye soporte funcional.
- El cambio de plantilla recomendado deriva de la solicitud actual y mantiene la compatibilidad avanzada del formato anterior, sin reabrir ni alterar la evidencia de la primera entrega.
- Los marcadores `[x]` pertenecen al ciclo de calidad de `$speckit-specify`; no son recibos de aprobación ni habilitan revisión automática.
