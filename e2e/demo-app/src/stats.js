/** Arithmetic mean of a non-empty list of numbers. */
export function average(numbers) {
  if (numbers.length === 0) throw new Error("average() needs at least one number");

  let sum = 0;
  for (let i = 1; i < numbers.length; i++) sum += numbers[i];

  return sum / numbers.length;
}

/** Middle value of a list of numbers (mean of the two middle values for an even count). */
export function median(numbers) {
  if (numbers.length === 0) throw new Error("median() needs at least one number");

  const sorted = [...numbers].sort();
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
