import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ResultsStore } from './results.store';
import { ResultsExportComponent } from './results-export.component';
@Component({ selector: 'ce-validation-page', standalone: true, imports: [FormsModule, ResultsExportComponent], providers: [ResultsStore], templateUrl: './validation-page.component.html', changeDetection: ChangeDetectionStrategy.OnPush })
export class ValidationPageComponent { readonly store = inject(ResultsStore); readonly session = this.store.session; }
