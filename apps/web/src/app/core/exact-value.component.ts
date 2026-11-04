import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { NormalizedValue } from '@ce/contracts';
import { normalizedText } from './exact-value';
@Component({ selector: 'ce-exact-value', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="exact-value" [title]="text()">{{ text() }}</span>` })
export class ExactValueComponent {
  readonly value = input<NormalizedValue | undefined>(); readonly decimals = input('');
  readonly text = computed(() => normalizedText(this.value(), this.decimals()));
}
