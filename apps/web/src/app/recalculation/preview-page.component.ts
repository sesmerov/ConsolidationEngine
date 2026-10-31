import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { versionLabel } from '../core/display';
import { PreviewStore } from './preview.store';
import { ApplyComponent } from './apply.component';
import { ComparisonComponent } from './comparison.component';
@Component({ selector: 'ce-preview-page', standalone: true, imports: [FormsModule, DatePipe, ApplyComponent, ComparisonComponent], providers: [PreviewStore], changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './preview-page.component.html' })
export class PreviewPageComponent { readonly store = inject(PreviewStore); readonly session = this.store.session; readonly versionLabel = versionLabel; }
