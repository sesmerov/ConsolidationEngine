import { expect, test } from '@playwright/test';
import { chooseNativeOptionWithKeyboard, navigateStage } from './workflow-helpers.js';
import { createAnalystWorkspace, expectNoTechnicalText, runAnalystAction, uploadDemo } from './useful-information-helpers.js';

test('S02/D01/D03: demo choices change meaningful instructions and generic missing-data help is absent',async({page})=>{
  await createAnalystWorkspace(page);
  const demo=page.getByRole('region',{name:'Demostraciones guiadas',exact:true}), selector=page.getByLabel('Demostración',{exact:true});
  const summary=demo.locator('summary').filter({hasText:'Ver pasos y resultados esperados'});
  await summary.focus();await page.keyboard.press('Enter');await expect(demo.locator('details')).toHaveAttribute('open','');
  await expect(demo).not.toContainText('Preparar revisión de destinos');await expect(demo).not.toContainText('Guardar configuración');
  await selector.selectOption('finrep');await expect(demo).toContainText('90,00 → 100,00');await expect(demo.getByRole('button',{name:'Descargar informe FINREP',exact:true})).toBeVisible();
  await selector.selectOption('types');await expect(demo).toContainText('sólo de validación');await expect(demo.getByRole('button',{name:'Descargar informe de texto y fechas',exact:true})).toBeVisible();
  await summary.focus();await page.keyboard.press('Space');await expect(demo.locator('details')).not.toHaveAttribute('open','');
  await expect(page.getByText('Cómo se identifican los datos ausentes',{exact:true})).toHaveCount(0);
  await expectNoTechnicalText(page);
});

test('S01/S09/S13: single context/run/preview are readable and a second actual choice enables the history selector',async({page})=>{
  test.setTimeout(150000);await createAnalystWorkspace(page);await uploadDemo(page,'finrep');
  await page.getByRole('button',{name:'Inspeccionar archivos',exact:true}).click();await page.getByRole('button',{name:'Confirmar carga',exact:true}).click();
  await expect(page.locator('.data-summary')).toBeVisible();
  await expect(page.getByText('Cómo se identifican los datos ausentes',{exact:true})).toHaveCount(0);
  const rule=page.locator('details.rule-row').first();await rule.locator('summary').focus();await page.keyboard.press('Enter');
  await expect(rule).toContainText('demo-finrep-catalog.xlsx');await expect(rule.locator('pre')).not.toBeEmpty();
  await rule.locator('summary').focus();await page.keyboard.press('Space');await expect(rule).not.toHaveAttribute('open','');
  for(const [status,count] of [['error',0],['unsupported',0],['applicable',5],['not_applicable',0],['not_evaluable',0],['',5]] as const){
    await chooseNativeOptionWithKeyboard(page,page.getByLabel('Estado',{exact:true}),status);await expect(page.locator('details.rule-row')).toHaveCount(count);
    if(!count)await expect(page.getByText('Sin coincidencias',{exact:false})).toBeVisible();
  }
  await navigateStage(page,'validation');await expect(page.locator('#context-selector')).toHaveCount(0);await expect(page.locator('#validation-run')).toHaveCount(0);
  const first=await runAnalystAction(page,'/validations','Validar informes');await expect(page.getByRole('heading',{name:'Ejecución terminada',exact:true})).toBeVisible();
  await expect(page.locator('#validation-run')).toHaveCount(0);await expect(page.locator('.history-controls')).toContainText('Terminada');
  for(const [status,count] of [['pass',2],['fail',3],['error',0],['not_applicable',0],['not_evaluable',0],['',5]] as const){
    await page.getByLabel('Estado del resultado',{exact:true}).selectOption(status);await page.getByRole('button',{name:'Filtrar resultados',exact:true}).click();
    await expect(page.locator('.result-row')).toHaveCount(count);if(!count)await expect(page.getByText('No hay resultados para esta búsqueda.',{exact:true})).toBeVisible();
  }
  await runAnalystAction(page,'/validations','Validar informes');const runSelector=page.getByLabel('Ejecución',{exact:true});await expect(runSelector.locator('option')).toHaveCount(2);
  await runSelector.selectOption(first.resultRef.id);await expect(runSelector).toHaveValue(first.resultRef.id);
  await navigateStage(page,'recalculation');await expect(page.locator('#preview-history')).toHaveCount(0);
  const simulated=await runAnalystAction(page,'/recalculation-operations','Simular recálculos');await expect(page.getByRole('table',{name:'Propuestas de recálculo',exact:true})).toBeVisible();
  await expect(page.locator('#preview-history')).toHaveCount(0);await expect(page.locator('.history-controls')).toContainText('Preparada');
  for(const [status,count] of [['blocked',0],['available',2],['obsolete',0],['discarded',0],['applied',0],['',2]] as const){
    await page.getByLabel('Estado de propuesta',{exact:true}).selectOption(status);await page.getByRole('button',{name:'Filtrar propuestas',exact:true}).click();
    await expect(page.locator('.proposal-row')).toHaveCount(count);await expect(page.getByRole('heading',{name:'Selección: 2 de 2 disponibles',exact:true})).toBeVisible();
    if(!count)await expect(page.getByText('No hay propuestas para esta búsqueda.',{exact:true})).toBeVisible();
  }
  const antecedents=page.getByRole('button',{name:'1 antecedente',exact:true});await antecedents.focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'Antecedentes de la propuesta',exact:true})).toBeVisible();
  await expect(page.getByLabel('Seleccionar antecedente FIN_TOTAL_CASH',{exact:true})).toBeChecked();
  await page.getByRole('button',{name:'Cerrar antecedentes',exact:true}).focus();await page.keyboard.press('Enter');await expect(antecedents).toBeFocused();
  await page.getByRole('button',{name:'Revisar destinos',exact:true}).click();await expect(page.getByRole('button',{name:'Simular recálculos',exact:true})).toBeEnabled({timeout:60_000});
  await runAnalystAction(page,'/recalculation-operations','Simular recálculos');const previewSelector=page.getByLabel('Previsualización conservada',{exact:true});await expect(previewSelector.locator('option')).toHaveCount(2);
  await previewSelector.selectOption(simulated.resultRef.id);await expect(previewSelector).toHaveValue(simulated.resultRef.id);await expectNoTechnicalText(page);
});

test('D05/C13: text and dates retain their evidence without a numeric disclosure and keyboard closing returns to the rule',async({page})=>{
  test.setTimeout(120000);await createAnalystWorkspace(page);await uploadDemo(page,'types');
  await page.getByRole('button',{name:'Inspeccionar archivos',exact:true}).click();await page.getByRole('button',{name:'Confirmar carga',exact:true}).click();
  await navigateStage(page,'validation');await runAnalystAction(page,'/validations','Validar informes');
  const triggers=page.getByRole('button',{name:/^Ver cálculo y origen de /});await expect(triggers).toHaveCount(8);
  for(const index of [0,4]){
    const trigger=triggers.nth(index);await trigger.focus();await page.keyboard.press('Enter');const detail=page.locator('ce-calculation-detail');
    await expect(detail.getByRole('heading',{name:/Cálculo y origen/})).toBeFocused();await expect(detail.locator('.calculation-explanation')).toHaveCount(0);
    const origins=detail.getByRole('button',{name:/^Archivos y celdas de origen/});await origins.focus();await page.keyboard.press('Enter');await expect(detail).toContainText('demo-types-report.xlsx');
    const reads=detail.getByRole('button',{name:/^Entradas utilizadas/});await reads.focus();await page.keyboard.press('Enter');await expect(detail.getByRole('table',{name:'Entradas utilizadas',exact:true})).toBeVisible();
    await detail.getByRole('button',{name:'Cerrar detalle',exact:true}).focus();await page.keyboard.press('Enter');await expect(trigger).toBeFocused();
  }
  await expectNoTechnicalText(page);
});
