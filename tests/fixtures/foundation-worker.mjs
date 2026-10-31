import { isMainThread } from 'node:worker_threads';
export async function execute(input, context) {
  context.progress(1, 1);
  return { complete: true, records: [{ key: 'fixture:thread', value: { value: input.value, isMainThread } }] };
}
