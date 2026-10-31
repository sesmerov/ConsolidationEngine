import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { PreviewStore } from './preview.store';
@Component({ selector: 'ce-preview-page', standalone: true, imports: [FormsModule], providers: [PreviewStore], changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './preview-page.component.html' })
export class PreviewPageComponent { readonly store = inject(PreviewStore); readonly session = this.store.session; }
