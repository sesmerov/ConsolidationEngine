import { afterEach, expect, it } from 'vitest';
import readXlsxFile from 'read-excel-file/node';
import { createApp } from '../../apps/api/src/app.js';
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
it('serves two fixed, authenticated teaching workbooks with instructions and literal synthetic inputs', async () => {
  const app = await createApp(); apps.push(app); const headers = { host: '127.0.0.1:3000', 'x-ce-session': (await app.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:3000' } })).json().sessionToken };
  for (const [kind, filename] of [['catalog', 'ejemplo-catalogo.xlsx'], ['report', 'ejemplo-informe.xlsx']]) {
    const url = '/api/v1/templates/guided-' + kind; expect((await app.inject({ url, headers: { host: headers.host } })).statusCode).toBe(403);
    expect((await app.inject({ url: url + '?path=outside', headers })).statusCode).toBe(400);
    const response = await app.inject({ url, headers }); expect(response.statusCode).toBe(200); expect(response.headers['content-disposition']).toBe('attachment; filename="' + filename + '"');
    const sheets = await readXlsxFile(response.rawPayload, { trim: false }); const instructions = sheets.find(sheet => sheet.sheet === 'Instructions')!;
    expect(instructions.data.flat().join(' ')).toContain('No necesitas editar');
    expect(instructions.data.flat().join(' ')).toMatch(/A=11, B=5, C=7 y D=22/); expect(instructions.data.flat().join(' ')).toContain('A=12.00 y D=24.00');
    for (const sheet of sheets) for (const row of sheet.data) for (const value of row) if (value !== null) expect(typeof value).toBe('string');
    if (kind === 'report') {
      expect(sheets.map(sheet => sheet.sheet)).toEqual(['Instructions', 'Contexts', 'Coordinates', 'Facts']); expect(sheets.find(sheet => sheet.sheet === 'Facts')!.data.slice(1).map(row => row[6])).toEqual(['11', '5', '7', '22']);
    } else expect(sheets.find(sheet => sheet.sheet === 'Synthetic_rules')!.data.slice(1).map(row => row[0])).toEqual(['SYNTHETIC_A', 'SYNTHETIC_D']);
  }
  expect(app.ce.store.currentWorkspaceId).toBeUndefined();
});
