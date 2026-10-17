import { sha256 } from './hash-node.ts';
export type AddressValue = string | number | bigint | readonly AddressValue[];
export type Hash = (bytes: Uint8Array) => Uint8Array;
const mask = (1n << 64n) - 1n;
export function canonicalJSON(value: AddressValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new RangeError('Random addresses contain only arrays, strings and exact integers');
}
export function splitMix64(seed: bigint): () => bigint {
  let state = seed & mask;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & mask;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
    return (z ^ (z >> 31n)) & mask;
  };
}
const rotate = (x: bigint, n: bigint) => ((x << n) | (x >> (64n - n))) & mask;
export function xoshiro256(seed: bigint): () => bigint {
  const sm = splitMix64(seed);
  const state = [sm(), sm(), sm(), sm()];
  return () => {
    const result = (rotate((state[1] * 5n) & mask, 7n) * 9n) & mask,
      t = (state[1] << 17n) & mask;
    state[2] ^= state[0];
    state[3] ^= state[1];
    state[1] ^= state[2];
    state[0] ^= state[3];
    state[2] ^= t;
    state[3] = rotate(state[3], 45n);
    return result;
  };
}
export function generator(address: AddressValue, hash: Hash = sha256): () => number {
  const digest = hash(new TextEncoder().encode(canonicalJSON(address)));
  let seed = 0n;
  for (const byte of digest.slice(0, 8)) seed = (seed << 8n) | BigInt(byte);
  const next = xoshiro256(seed);
  return () => Number(next() >> 11n) * 2 ** -53;
}
