/** SpreadsheetML ST_Xstring: protect literal escape-looking text and decode exactly once. */
export function validXmlText(value: string): boolean {
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (!(point === 9 || point === 10 || point === 13 || point >= 0x20 && point <= 0xd7ff || point >= 0xe000 && point <= 0xfffd || point >= 0x10000 && point <= 0x10ffff)) return false;
  }
  return true;
}
export function encodeSpreadsheetText(value: string): string {
  if (!validXmlText(value)) throw new Error('Unrepresentable XML text');
  // Match only the leading underscore: escape-looking sequences can overlap at their boundary.
  return value.replace(/_(?=x[0-9a-fA-F]{4}_)/g, '_x005F_').replace(/\r/g, '_x000D_');
}
export function decodeSpreadsheetText(value: string): string {
  const decoded = value.replace(/_x([0-9a-fA-F]{4})_/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  if (!validXmlText(decoded)) throw new Error('Unrepresentable XML text');
  return decoded;
}
