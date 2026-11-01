export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function namesMatch(header: string, tokens: string[]): boolean {
  const normalizedHeader = normalizeName(header);
  if (!normalizedHeader) return false;
  return tokens.some((token) => {
    const normalizedToken = normalizeName(token);
    return normalizedToken.length > 0 && normalizedHeader.includes(normalizedToken);
  });
}
