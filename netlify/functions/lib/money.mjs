// Money is integer pence everywhere. Only format at the edges.
export function gbp(pence) {
  const v = (pence || 0) / 100;
  return '£' + v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (f(x) || 0), 0);
