import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseExpression } from '../packages/core/src/parser.ts';
import { lex } from '../packages/core/src/lexer.ts';
import { Rational } from '@midi-madness/foundation/time';
import type { Expression } from '../packages/core/src/ast.ts';
function evaluate(expr: Expression): Rational {
  if (expr.kind === 'number') return Rational.parse(expr.text);
  if (expr.kind === 'group') return evaluate(expr.value.elements[0]);
  if (expr.kind === 'binary') {
    const a = evaluate(expr.left),
      b = evaluate(expr.right);
    if (expr.operator === '+') return a.add(b);
    if (expr.operator === '-') return a.sub(b);
    if (expr.operator === '*') return a.mul(b);
    if (expr.operator === '/') return a.div(b);
  }
  throw new Error(`Not a scalar expression: ${expr.kind}`);
}
test('G01 exact expression values', () => {
  const sources = ['0.55 + 0 * 0.4', '2 * 0.75 - 1', '8 / 4 / 2', '(0.55 + 0) * 0.4'];
  assert.deepEqual(
    sources.map((s) => evaluate(parseExpression(s).expression!).toString()),
    ['11/20', '1/2', '1/1', '11/50'],
  );
});
test('operator spacing errors and fraction/sign distinction', () => {
  for (const source of ['a+1', '1+2', 'a *2', '8/ 4', 'a -1'])
    assert(
      parseExpression(source).diagnostics.some((d) => d.code === 'S030'),
      source,
    );
  assert.deepEqual(parseExpression('8 / 4 / 2').diagnostics, []);
  assert.equal(parseExpression('1/16').expression?.kind, 'number');
  assert.deepEqual(
    lex('a -1 1/16 a-1')
      .tokens.filter((t) => t.kind !== 'NL' && t.kind !== 'EOF')
      .map((t) => t.text),
    ['a', '-1', '1/16', 'a-1'],
  );
});
test('literal spelling preserves sharps, octaves, stacks and hit offsets', () => {
  const result = parse('mm 1\nmotif p = | C#5+B4 3b 7v |\nrhythm r = | x+7 x-5 |\n');
  assert.deepEqual(result.diagnostics, []);
  const p = result.ast.statements[0],
    r = result.ast.statements[1];
  assert(p.kind === 'binding' && r.kind === 'binding');
  const literal = p.value.elements[0],
    hits = r.value.elements[0];
  assert(literal.kind === 'literal' && hits.kind === 'literal');
  assert.equal(literal.groups[0].length, 3);
  assert.equal(literal.groups[0][0].atoms.length, 2);
  assert.equal(hits.groups[0][0].atoms.length, 1);
});
test('unbracketed literal chaining yields a usable S031 text edit', () => {
  const source = 'mm 1\nrhythm r = steps 1/16: x . x .rotate(1/16)\n';
  const result = parse(source),
    d = result.diagnostics[0];
  assert.equal(d.code, 'S031');
  assert.equal(d.fixes.length, 1);
  const edit = d.fixes[0].edits[0];
  const lines = source.split('\n');
  assert.equal(edit.span.line, edit.span.endLine);
  const line = lines[edit.span.line - 1];
  lines[edit.span.line - 1] =
    line.slice(0, edit.span.col - 1) + edit.insert + line.slice(edit.span.endCol - 1);
  assert.deepEqual(parse(lines.join('\n')).diagnostics, []);
});
test('collects independent errors and resumes at subsequent statements', () => {
  const result = parse('mm 1\nmotif bad = | [ E4 |\npart with\n  length 0.2\nsignal fine = 1\n');
  assert.deepEqual(
    result.diagnostics.map((d) => d.code),
    ['S001', 'S040', 'R003'],
  );
  assert.equal(result.ast.statements.at(-1)?.kind, 'binding');
});
test('condition precedence and comma lists are preserved', () => {
  const result = parse('mm 1\nwhen gate = not in build, build2 and bar < 8 of section or always\n');
  assert.deepEqual(result.diagnostics, []);
  const statement = result.ast.statements[0];
  assert(statement.kind === 'when');
  const c = statement.condition;
  assert(c.kind === 'condition');
  assert.equal(c.operator, 'or');
  assert(c.left.kind === 'condition');
  assert.equal(c.left.operator, 'and');
  assert(c.left.left.kind === 'not');
  assert(c.left.left.value.kind === 'clause');
  assert.deepEqual(c.left.left.value.tokens, ['in', 'build', ',', 'build2']);
});
test('tabs, leading decimals, unclosed strings, indentation and unknown statements', () => {
  assert.equal(lex('\tsignal a = .35').diagnostics[0].code, 'S010');
  assert.equal(parse('mm 1\nsignal a = .35\n').diagnostics[0].code, 'S020');
  assert(parse('mm 1\nsong "unclosed\n  tempo 100\n').diagnostics.some((d) => d.code === 'S001'));
  assert(lex('part a\n    role bed\n  plays chords\n').diagnostics.some((d) => d.code === 'S001'));
  const result = parse('mm 1\nmotfi hook = | E4 |\n');
  assert.match(result.diagnostics[0].message, /did you mean motif/);
});

test('score files require format 1 and reject unsupported headers', () => {
  assert.equal(parse('mm 1\n').ast.version, '1');
  assert.deepEqual(parse('mm 1\n').diagnostics, []);
  for (const source of ['mm 0\n', 'mm 2\n', 'mm 99\n', 'song "Missing header"\n']) {
    assert.ok(
      parse(source).diagnostics.some((d) => d.severity === 'error'),
      source,
    );
  }
});
