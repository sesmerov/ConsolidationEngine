export const uuidSchema = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' } as const;
export const civilDateSchema = { type: 'string', format: 'date', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
/** The v2 civil range excludes 0000 without changing administrative dates accepted by v1. */
export const civilDateV2Schema = { type: 'string', format: 'date', pattern: '^(?!0000)\\d{4}-\\d{2}-\\d{2}$' } as const;
export const rationalSchema = { type: 'object', additionalProperties: false, required: ['numerator', 'denominator'], properties: {
  numerator: { type: 'string', pattern: '^-?(0|[1-9][0-9]*)$' }, denominator: { type: 'string', pattern: '^[1-9][0-9]*$' },
} } as const;
export const textValueSchema = { type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: {
  kind: { const: 'text' }, value: { type: 'string', maxLength: 32_767 },
} } as const;
export const dateValueSchema = { type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: {
  kind: { const: 'date' }, value: civilDateV2Schema,
} } as const;
export const normalizedValueSchema = { anyOf: [rationalSchema, { type: 'boolean' }, textValueSchema, dateValueSchema] } as const;
export const sourceLocatorSchema = { type: 'object', additionalProperties: false, properties: {
  fileId: uuidSchema, sheet: { type: 'string', maxLength: 100 }, row: { type: 'integer', minimum: 1 },
  column: { type: 'string', maxLength: 20 }, ruleCode: { type: 'string', maxLength: 200 },
} } as const;
export const createWorkspaceSchema = { type: 'object', additionalProperties: false, required: ['name'], properties: {
  name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
} } as const;
export const workspaceParamsSchema = { type: 'object', additionalProperties: false, required: ['workspaceId'], properties: { workspaceId: uuidSchema } } as const;
export const jobParamsSchema = { type: 'object', additionalProperties: false, required: ['workspaceId', 'jobId'], properties: { workspaceId: uuidSchema, jobId: uuidSchema } } as const;
export const baseVersionSchema = { type: 'object', additionalProperties: false, required: ['baseVersionId'], properties: { baseVersionId: uuidSchema } } as const;
export const emptyQuerySchema = { type: 'object', additionalProperties: false, properties: {} } as const;
export const UUID_PATTERN = new RegExp(uuidSchema.pattern);
