export function cycleIndex(currentIndex: number, length: number, direction: 'next' | 'prev'): number {
  if (length <= 0) return 0;
  if (direction === 'next') {
    return (currentIndex + 1) % length;
  }
  return (currentIndex - 1 + length) % length;
}

export function findNextIndexByInitial<T>(
  entries: readonly T[],
  currentIndex: number,
  key: string,
  labelFor: (entry: T) => string,
): number {
  if (entries.length === 0 || key.length !== 1 || !/[a-z]/i.test(key)) {
    return -1;
  }
  const target = key.toLowerCase();
  for (let step = 1; step <= entries.length; step += 1) {
    const candidateIndex = (currentIndex + step) % entries.length;
    const label = labelFor(entries[candidateIndex]).trim().toLowerCase();
    if (label.startsWith(target)) {
      return candidateIndex;
    }
  }
  return -1;
}
