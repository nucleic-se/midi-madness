import type { Argument, Expression, Item, Sequence } from './ast.ts';
export function sequenceText(seq: Sequence): string {
  return seq.elements.map(expressionText).join(' ');
}
export function argumentText(arg: Argument): string {
  if (arg.kind === 'sequence') return sequenceText(arg);
  if (arg.kind === 'clause') return arg.tokens.join(' ');
  return `${conditionText(arg.condition)}: ${arg.operations.map(sequenceText).join(', ')}`;
}
export function conditionText(condition: import('./ast.ts').Condition): string {
  if (condition.kind === 'clause') return condition.tokens.join(' ');
  if (condition.kind === 'not') return `not (${conditionText(condition.value)})`;
  return `(${conditionText(condition.left)}) ${condition.operator} (${conditionText(condition.right)})`;
}
export function expressionText(e: Expression): string {
  if (e.kind === 'call' && e.name === '__per')
    return `per ${e.clock === 'song' ? 'song ' : ''}${argumentText(e.args[0])}${argumentText(e.args[1]) === '1' ? ' smooth' : ''}: ${e.args.slice(2).map(argumentText).join(', ')}`;
  if (e.kind === 'call' && e.name === '__sections')
    return `by section: ${e.args
      .slice(1)
      .filter((_, i) => i % 2 === 0)
      .map((key, i) => `${argumentText(key)} ${argumentText(e.args[2 + i * 2])}`)
      .join(', ')}${argumentText(e.args[0]) === '' ? '' : ` smooth ${argumentText(e.args[0])}`}`;
  if (e.kind === 'number') return e.text;
  if (e.kind === 'name') return e.name;
  if (e.kind === 'span') return `${expressionText(e.value)} ${e.unit}`;
  if (e.kind === 'binary')
    return `(${expressionText(e.left)} ${e.operator} ${expressionText(e.right)})`;
  if (e.kind === 'range')
    return `${e.from ? expressionText(e.from) : ''}..${e.to ? expressionText(e.to) : ''}`;
  if (e.kind === 'group') return `(${sequenceText(e.value)})`;
  if (e.kind === 'label') return `${expressionText(e.value)} as ${e.name}`;
  if (e.kind === 'alternation') return `<${e.branches.map(expressionText).join(' ')}>`;
  if (e.kind === 'call') return `${e.name}(${e.args.map(argumentText).join(', ')})`;
  if (e.kind === 'operation')
    return `${expressionText(e.receiver)}.${e.name}${e.args.length ? `(${e.args.map(argumentText).join(', ')})` : ''}`;
  if (e.kind === 'shape')
    return `${e.name} ${expressionText(e.value)}${e.every ? ` every ${sequenceText(e.every)}` : ''}`;
  if (e.mode === 'bars') return `| ${e.groups.map((g) => g.map(itemText).join(' ')).join(' | ')} |`;
  return `${e.mode} ${sequenceText(e.duration!)}${e.smooth ? ' smooth' : ''}: ${e.shape ? expressionText(e.shape) : e.groups[0].map(itemText).join(' ')}`;
}
function itemText(item: Item): string {
  return (
    item.atoms
      .map((atom) =>
        atom.kind === 'clause'
          ? atom.tokens.join('')
          : atom.kind === 'subdivision'
            ? `[${atom.items.map(itemText).join(' ')}]`
            : atom.kind === 'alternation' && 'items' in atom
              ? `<${atom.items.map(itemText).join(' ')}>`
              : `(${expressionText(atom as Expression)})`,
      )
      .join('+') +
    (item.weight ? `@${item.weight}` : '') +
    (item.ratchet ? `*${item.ratchet}` : '') +
    (item.euclid ? `(${item.euclid.join(',')})` : '') +
    (item.options.length ? `{${item.options.map((o) => o.tokens.join(' ')).join(', ')}}` : '')
  );
}
