/** Aadhaar number helpers: 12 digits, cannot start with 0 or 1, last digit is a Verhoeff checksum. */

const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function normalizeAadhaar(input: string): string {
  return input.replace(/[\s-]/g, "");
}

export function verhoeffValid(digits: string): boolean {
  let c = 0;
  const rev = digits.split("").reverse().map(Number);
  for (let i = 0; i < rev.length; i++) c = D[c][P[i % 8][rev[i]]];
  return c === 0;
}

/** Returns an error message, or null when the number is a valid Aadhaar. */
export function aadhaarProblem(input: string): string | null {
  const n = normalizeAadhaar(input);
  if (!/^\d{12}$/.test(n)) return "Aadhaar must be 12 digits";
  if (/^[01]/.test(n)) return "Aadhaar cannot start with 0 or 1";
  if (!verhoeffValid(n)) return "Aadhaar number is invalid (checksum failed) — please re-check the digits";
  return null;
}

export function maskAadhaar(last4: string | null): string | null {
  return last4 ? `XXXX XXXX ${last4}` : null;
}

export function formatAadhaar(n: string): string {
  return normalizeAadhaar(n).replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3");
}
