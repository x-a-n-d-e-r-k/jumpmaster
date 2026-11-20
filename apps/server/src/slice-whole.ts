/** The first `max` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair. */
export function sliceWhole(text: string, max: number): string {
  if (text.length <= max) return text;
  const high = text.charCodeAt(max - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max);
}
