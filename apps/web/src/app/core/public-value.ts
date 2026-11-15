import type { LargeValueDescriptorDTO, PublicValue } from '@ce/contracts';
export type PublicItemsPage<T extends { readonly items: readonly unknown[] }> = Omit<T, 'items'> & { readonly items: readonly PublicValue<T['items'][number]>[] };
export type ResolvedItemsPage<T extends { readonly items: readonly unknown[] }> = Omit<T, 'items'> & { readonly items: readonly Exclude<T['items'][number], LargeValueDescriptorDTO>[] };
export function isLargeValue(value: unknown): value is LargeValueDescriptorDTO {
  return !!value && typeof value === 'object' && 'valueRef' in value && 'sha256' in value && 'byteLength' in value && 'mediaType' in value;
}
