// ESLint rule (HeoPress P07a task 1.3, ADR-0019 §6): the Carbon workspace's
// visible text goes through translation keys. Flags JSX text and string
// literals in text-bearing attributes that contain letters or CJK characters.
// Applied to `apps/studio/src/workspace/**`; legacy pages moved under
// Settings › Advanced keep their English until translated
// (docs/backlog/studio-legacy-i18n.md).
const WORDS = /[A-Za-z㐀-鿿]/;
const TEXT_ATTRIBUTES = new Set(['title', 'placeholder', 'alt', 'aria-label', 'aria-description', 'label']);

export const noUiLiterals = {
  meta: {
    type: 'problem',
    docs: { description: 'Visible Studio text must come from a translation key.' },
    schema: [],
    messages: { literal: 'Use a translation key (useTranslation) instead of the literal "{{text}}".' },
  },
  create(context) {
    const report = (node, text) =>
      context.report({ node, messageId: 'literal', data: { text: text.trim().slice(0, 40) } });
    return {
      JSXText(node) {
        if (WORDS.test(node.value)) report(node, node.value);
      },
      JSXAttribute(node) {
        const name = typeof node.name.name === 'string' ? node.name.name : '';
        if (!TEXT_ATTRIBUTES.has(name) || !node.value) return;
        if (node.value.type === 'Literal' && typeof node.value.value === 'string' && WORDS.test(node.value.value)) {
          report(node.value, node.value.value);
        }
        if (node.value.type === 'JSXExpressionContainer') {
          const expr = node.value.expression;
          if (expr.type === 'Literal' && typeof expr.value === 'string' && WORDS.test(expr.value)) report(expr, expr.value);
          if (expr.type === 'TemplateLiteral' && expr.quasis.some((q) => WORDS.test(q.value.cooked ?? ''))) report(expr, 'template');
        }
      },
    };
  },
};

export default { rules: { 'no-ui-literals': noUiLiterals } };
