export function convertLineWidth(lines: string[], fromWidth: number, toWidth: number): string[] {
  return lines.join(' ').match(new RegExp(`.{1,${toWidth}}`, 'g')) || [];
}
