import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { versionLabel } from '../core/display';
import { ResultsStore } from './results.store';
import { ResultsExportComponent } from './results-export.component';
import { DirectionsComponent } from '../recalculation/directions.component';
@Component({ selector: 'ce-validation-page', standalone: true, imports: [FormsModule, DatePipe, ResultsExportComponent, DirectionsComponent], providers: [ResultsStore], templateUrl: './validation-page.component.html', changeDetection: ChangeDetectionStrategy.OnPush })
export class ValidationPageComponent { readonly store = inject(ResultsStore); readonly session = this.store.session; readonly versionLabel = versionLabel; }
