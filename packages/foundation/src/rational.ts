/** Exact, normalized rational arithmetic. Units belong to the caller. No floating point conversion is used in arithmetic. */
export class Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
  constructor(numerator: bigint | number, denominator: bigint | number = 1n) {
    let n = integer(numerator),
      d = integer(denominator);
    if (d === 0n) throw new RangeError('Rational denominator must be nonzero');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const factor = gcd(n < 0n ? -n : n, d);
    this.numerator = n / factor;
    this.denominator = d / factor;
  }
  static parse(text: string): Rational {
    if (/^[+-]?\d+\/\d+$/.test(text)) {
      const [n, d] = text.split('/');
      return new Rational(BigInt(n!), BigInt(d!));
    }
    if (!/^[+-]?\d+(\.\d+)?$/.test(text)) throw new RangeError(`Invalid rational: ${text}`);
    const [whole, fraction = ''] = text.split('.');
    return new Rational(BigInt(whole + fraction), 10n ** BigInt(fraction.length));
  }
  /** Preserve a finite number's decimal spelling, including exponent notation.
   * This does not infer an intended fraction from a rounded number.
   */
  static fromNumber(value: number): Rational {
    if (!Number.isFinite(value)) throw new RangeError('Rational input must be finite');
    const [mantissa, exponent = '0'] = String(value).toLowerCase().split('e');
    const decimal = Rational.parse(mantissa!);
    const shift = Number(exponent);
    return shift >= 0
      ? decimal.mul(new Rational(10n ** BigInt(shift)))
      : decimal.div(new Rational(10n ** BigInt(-shift)));
  }
  /** Convert only at a runtime boundary. Throws when the result overflows. */
  toNumber(): number {
    const numerator = Number(this.numerator);
    const denominator = Number(this.denominator);
    if (Number.isFinite(numerator) && Number.isFinite(denominator)) return numerator / denominator;
    // Scale large operands together so a finite ratio is not Infinity / Infinity.
    const sign = this.numerator < 0n ? -1 : 1;
    const n = (this.numerator < 0n ? -this.numerator : this.numerator).toString();
    const d = this.denominator.toString();
    const value =
      sign *
      (Number(n.slice(0, 16)) / Number(d.slice(0, 16))) *
      10 ** (n.length - Math.min(16, n.length) - (d.length - Math.min(16, d.length)));
    if (!Number.isFinite(value)) throw new RangeError('Rational exceeds numeric range');
    return value;
  }
  add(other: Rational): Rational {
    return new Rational(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }
  sub(other: Rational): Rational {
    return this.add(other.negate());
  }
  mul(other: Rational): Rational {
    return new Rational(this.numerator * other.numerator, this.denominator * other.denominator);
  }
  div(other: Rational): Rational {
    return new Rational(this.numerator * other.denominator, this.denominator * other.numerator);
  }
  negate(): Rational {
    return new Rational(-this.numerator, this.denominator);
  }
  compare(other: Rational): number {
    const d = this.numerator * other.denominator - other.numerator * this.denominator;
    return d < 0n ? -1 : d > 0n ? 1 : 0;
  }
  equals(other: Rational): boolean {
    return this.compare(other) === 0;
  }
  floor(): bigint {
    const q = this.numerator / this.denominator;
    return this.numerator < 0n && this.numerator % this.denominator !== 0n ? q - 1n : q;
  }
  mod(other: Rational): Rational {
    if (other.numerator <= 0n) throw new RangeError('Modulus must be positive');
    return this.sub(other.mul(new Rational(this.div(other).floor())));
  }
  toString(): string {
    return `${this.numerator}/${this.denominator}`;
  }
  toJSON(): string {
    return this.toString();
  }
}
function integer(value: number | bigint): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value))
    throw new RangeError('Use bigint for large integers and Rational.parse for decimals');
  return BigInt(value);
}
function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}
