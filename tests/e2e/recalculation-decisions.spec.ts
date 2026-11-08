import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { chooseNativeOptionWithKeyboard, importLegacyFixture, navigateStage } from './workflow-helpers.js';

async function current(page: Page) {
  const boot = await (await page.request.get('/api/v1/bootstrap')).json();
  const headers = { 'X-CE-Session': boot.sessionToken }, base = '/api/v1/workspaces/' + boot.activeWorkspaceId;
  return { headers, base, workspace: await (await page.request.get(base,{headers})).json() };
}
async function seed(page: Page, count: number) {
  const original = (await readXlsxFile(path.resolve('tests/fixtures/generated/eba-subset.xlsx'), {trim:false,parseNumber:x=>x}))[0]!;
  const rows = original.data.map(row => row.map(x => x === null ? null : String(x)));
  const rules = Array.from({length:count || 1},(_,i)=> { const row=[...rows[2]!]; row[0]='DECISION_'+String(i+1).padStart(3,'0'); row[1]='SYNTHETIC_005'; row[6]=count ? `{tC_01.00,r${1000+i*2},c0010}={tC_01.00,r${1001+i*2},c0010}` : '1>0'; row[7]=''; return row; });
  const catalog = await writeXlsxFile([rows[0]!,...rules].map(row=>row.map(value=>value===null?null:{type:String,value})),{sheet:original.sheet}).toBuffer();
  const sheets = (await readXlsxFile(path.resolve('tests/fixtures/generated/report-42.xlsx'), {trim:false,parseNumber:x=>x})).map(sheet=>({...sheet,data:sheet.data.map(row=>row.map(x=>x===null?null:String(x)))}));
  if(count) { const coordinates=sheets.find(s=>s.sheet==='Coordinates')!,facts=sheets.find(s=>s.sheet==='Facts')!;
    coordinates.data=[coordinates.data[0]!,...Array.from({length:count*2},(_,i)=>['demo','C_01.00','',String(1000+i),'0010','number','EUR','2','{}'])];
    facts.data=[facts.data[0]!,...Array.from({length:count*2},(_,i)=>['demo','C_01.00','',String(1000+i),'0010','value',i%2?'100':'90'])];
  }
  const workbookSheets = sheets.map(sheet => ({
    sheet: sheet.sheet,
    data: sheet.data.map(row => row.map(value => value === null ? null : {type:String,value})),
  }));
  const report=await writeXlsxFile(workbookSheets).toBuffer();
  await importLegacyFixture(page,{name:'decisions-005.xlsx',buffer:catalog},[{name:'report-005.xlsx',buffer:report}]);
}
async function validate(page:Page) { await navigateStage(page,'validation'); await page.getByRole('button',{name:'Validar informes',exact:true}).click(); await expect(page.getByRole('heading',{name:'Ejecución terminada',exact:true})).toBeVisible({timeout:60000}); }
test.beforeEach(async({page})=>{
  const boot=await(await page.request.get('/api/v1/bootstrap')).json(); if(boot.activeWorkspaceId){ const base='/api/v1/workspaces/'+boot.activeWorkspaceId,headers={'X-CE-Session':boot.sessionToken}; const old=await page.request.get(base,{headers}); await page.request.delete(base,{headers:{...headers,'If-Match':old.headers()['etag']!}}); }
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('Decisiones 005'); await page.getByRole('button',{name:'Crear conjunto',exact:true}).click();
});
test('entry without validation and ten entries with a compatible run never publish a version',async({page})=>{
  test.setTimeout(120000); await seed(page,1); await navigateStage(page,'recalculation');
  await expect(page.getByRole('button',{name:'Ir a Validar',exact:true})).toBeVisible(); await validate(page);
  const before=(await current(page)).workspace.versionIds;
  for(let i=0;i<10;i++){await navigateStage(page,'recalculation'); await expect(page.getByRole('heading',{name:'Elegir qué celdas recalcular',exact:true})).toBeVisible(); await expect(page.getByLabel('DECISION_001 · Destino')).toBeVisible(); if(i<9) await navigateStage(page,'validation');}
  expect((await current(page)).workspace.versionIds).toEqual(before);
  await chooseNativeOptionWithKeyboard(page,page.getByLabel('DECISION_001 · Destino'),'left');await page.getByRole('button',{name:'Revisar decisiones',exact:true}).click();await expect(page.getByLabel('DECISION_001 · Destino')).toHaveValue('left');expect((await current(page)).workspace.versionIds).toEqual(before);
  await expect(page.getByRole('button',{name:/Preparar revisión|Guardar configuración/})).toHaveCount(0);
});
test('decision 51 is globally pending and explicit omission persists before compound simulation',async({page})=>{
  test.setTimeout(120000); await seed(page,51); await validate(page); await navigateStage(page,'recalculation');
  const simulate=page.getByRole('button',{name:'Simular recálculos',exact:true}); await expect(simulate).toBeDisabled();
  const pager=page.getByLabel('Páginas de destinos'); await pager.getByRole('button',{name:'Siguiente',exact:true}).click();
  await page.getByLabel('DECISION_051 · Destino').selectOption('right');
  await page.getByRole('button',{name:'Revisar decisiones',exact:true}).click();
  await expect(page.getByLabel('DECISION_051 · Destino')).toHaveValue('right');
  await page.reload(); await navigateStage(page,'recalculation');
  await page.getByRole('button',{name:'Revisar decisiones',exact:true}).click();
  await expect(page.getByLabel('DECISION_051 · Destino')).toHaveValue('right');
  await page.getByRole('button',{name:'Omitir todos los destinos',exact:true}).click();
  await expect(page.getByText('Todas las reglas se han omitido',{exact:true})).toBeVisible();
  await page.reload(); await navigateStage(page,'recalculation'); await expect(page.getByText('Todas las reglas se han omitido',{exact:true})).toBeVisible();
  const before=(await current(page)).workspace.versionIds.length;
  await expect(simulate).toBeEnabled(); const posting=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/recalculation-operations')); await simulate.click(); expect((await posting).status()).toBe(202);
  await expect(page.getByText('No hay propuestas de recálculo en esta simulación.',{exact:true})).toBeVisible({timeout:60000});
  expect((await current(page)).workspace.versionIds.length).toBe(before+1);
  await expect(page.getByRole('region',{name:'Confirmar la aplicación',exact:true})).toHaveCount(0);
});
test('no eligible candidates has a clear download route and no destination controls',async({page})=>{
  test.setTimeout(90000); await seed(page,0); await validate(page); await navigateStage(page,'recalculation');
  await expect(page.getByText('No hay recálculos disponibles',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Ir a Descargar',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Simular recálculos',exact:true})).toBeDisabled();
  await expect(page.getByRole('table',{name:'Destinos de recálculo',exact:true})).toHaveCount(0);
});
