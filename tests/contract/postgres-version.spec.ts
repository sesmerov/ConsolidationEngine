import { describe, expect, it } from 'vitest';
import { assertSupportedPostgresVersion } from '../../apps/api/src/hosted/database.js';

describe('PostgreSQL compatibility boundary', () => {
  it.each(['170000', '170011', '180000', '180004'])('accepts verified major release %s', version => {
    expect(() => assertSupportedPostgresVersion(version)).not.toThrow();
  });
  it.each(['160013', '190000', '100000', '', 'NaN', '17e4', '180000.5'])('rejects unsupported or malformed version %s', version => {
    expect(() => assertSupportedPostgresVersion(version)).toThrow('PostgreSQL 17 or 18 is required');
  });
});
