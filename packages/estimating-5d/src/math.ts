import { KernelError, err, ok, type Result } from "@massingifc/core-kernel";
import type { Money } from "@massingifc/project-schema";

/**
 * Money and quantity arithmetic.
 *
 * `Money.amount` is **minor units** (cents, pence) held as an integer. Estimating multiplies rates
 * by quantities thousands of times and then sums them; doing that in floating point accumulates
 * drift that shows up as a BOQ total disagreeing with the sum of its own lines by a few pence,
 * which destroys trust in the whole document for a reason nobody can find.
 */

/**
 * Builds a money value, refusing anything that is not a finite number.
 *
 * `Math.round(NaN)` is `NaN`, so without this a single bad factor — a malformed rate in an
 * imported cost library, a division that produced Infinity — propagates silently through
 * `multiplyMoney` into a BOQ line total, an estimate subtotal, and a cashflow, with every
 * intermediate check passing. A total of `NaN` on a tender is worse than a thrown error.
 */
export const money = (amount: number, currency: string): Money => {
  if (!Number.isFinite(amount)) {
    throw new KernelError("COMMAND_FAILED", `Money amount must be finite, got ${amount}.`, {
      amount,
      currency,
    });
  }
  return { amount: Math.round(amount), currency };
};

/** Builds Money from a major-unit figure, e.g. `fromMajor(12.5, "GBP")` -> 1250. */
export const fromMajor = (major: number, currency: string, minorPerMajor = 100): Money =>
  money(Math.round(major * minorPerMajor), currency);

export const toMajor = (value: Money, minorPerMajor = 100): number => value.amount / minorPerMajor;

const currencyMismatch = (a: string, b: string): KernelError =>
  new KernelError("COMMAND_FAILED", `Cannot combine ${a} with ${b}.`, { a, b });

export function addMoney(a: Money, b: Money): Result<Money> {
  if (a.currency !== b.currency) return err(currencyMismatch(a.currency, b.currency));
  return ok(money(a.amount + b.amount, a.currency));
}

export function subtractMoney(a: Money, b: Money): Result<Money> {
  if (a.currency !== b.currency) return err(currencyMismatch(a.currency, b.currency));
  return ok(money(a.amount - b.amount, a.currency));
}

/**
 * Multiplies by a quantity, rounding half-away-from-zero.
 *
 * Rounds once, at the end. Rounding each component of a composite rate before summing is how a
 * unit rate ends up a penny out per line and a project's worth of lines ends up materially wrong.
 */
export function multiplyMoney(value: Money, factor: number): Money {
  const raw = value.amount * factor;
  const rounded = raw < 0 ? -Math.round(-raw) : Math.round(raw);
  return money(rounded, value.currency);
}

export function sumMoney(values: readonly Money[], currency: string): Result<Money> {
  let total = 0;
  for (const value of values) {
    if (value.currency !== currency) return err(currencyMismatch(currency, value.currency));
    total += value.amount;
  }
  return ok(money(total, currency));
}

export const percentOf = (value: Money, percent: number): Money =>
  multiplyMoney(value, percent / 100);

export const isZero = (value: Money): boolean => value.amount === 0;

// ---------------------------------------------------------------------------------------------
// Quantity expressions
// ---------------------------------------------------------------------------------------------

type Token = { kind: "number"; value: number } | { kind: "name"; value: string } | { kind: "op"; value: string };

/** Unary sign, bound tighter than any binary operator and applied right-to-left. */
const UNARY_MINUS = "u-";
const UNARY_PLUS = "u+";

const PRECEDENCE: Readonly<Record<string, number>> = {
  "+": 1,
  "-": 1,
  "*": 2,
  "/": 2,
  [UNARY_MINUS]: 3,
  [UNARY_PLUS]: 3,
};

const RIGHT_ASSOCIATIVE = new Set([UNARY_MINUS, UNARY_PLUS]);
const IS_UNARY = (operator: string): boolean => RIGHT_ASSOCIATIVE.has(operator);

function tokenize(expression: string): Result<Token[]> {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      let end = index;
      while (end < expression.length && /[0-9.]/.test(expression[end]!)) end++;
      const value = Number(expression.slice(index, end));
      if (!Number.isFinite(value)) {
        return err(new KernelError("COMMAND_FAILED", `Bad number in "${expression}".`, {}));
      }
      tokens.push({ kind: "number", value });
      index = end;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < expression.length && /[A-Za-z0-9_.]/.test(expression[end]!)) end++;
      tokens.push({ kind: "name", value: expression.slice(index, end) });
      index = end;
      continue;
    }
    if ("+-*/()".includes(char)) {
      // A sign is unary when nothing it could operate on precedes it: at the start, after another
      // operator, or after an opening bracket. `Width * -1` and `-5` are ordinary things for a
      // measurement rule to say, and previously both were rejected as malformed.
      const previous = tokens[tokens.length - 1];
      const expectsOperand =
        previous === undefined ||
        (previous.kind === "op" && previous.value !== ")");
      if ((char === "-" || char === "+") && expectsOperand) {
        tokens.push({ kind: "op", value: char === "-" ? UNARY_MINUS : UNARY_PLUS });
      } else {
        tokens.push({ kind: "op", value: char });
      }
      index++;
      continue;
    }
    return err(
      new KernelError("COMMAND_FAILED", `Unexpected character "${char}" in "${expression}".`, {}),
    );
  }
  return ok(tokens);
}

/**
 * Evaluates a takeoff expression such as `Width * Height` against an element's quantities.
 *
 * A hand-written shunting-yard rather than `new Function`: takeoff rules are user-authored content
 * that arrives from cost libraries and shared project files, and handing that to the JavaScript
 * engine would make a rule an arbitrary-code-execution vector. Supports `+ - * / ( )` and named
 * quantities, and nothing else — which is all a measurement rule needs.
 */
export function evaluateExpression(
  expression: string,
  variables: Readonly<Record<string, number>>,
): Result<number> {
  const tokens = tokenize(expression);
  if (!tokens.ok) return err(tokens.error);

  const values: number[] = [];
  const operators: string[] = [];

  const apply = (): Result<void> => {
    const operator = operators.pop();
    if (operator === undefined) {
      return err(new KernelError("COMMAND_FAILED", `Malformed expression "${expression}".`, {}));
    }

    if (IS_UNARY(operator)) {
      const operand = values.pop();
      if (operand === undefined) {
        return err(new KernelError("COMMAND_FAILED", `Malformed expression "${expression}".`, {}));
      }
      values.push(operator === UNARY_MINUS ? -operand : operand);
      return ok(undefined);
    }

    const right = values.pop();
    const left = values.pop();
    if (right === undefined || left === undefined) {
      return err(new KernelError("COMMAND_FAILED", `Malformed expression "${expression}".`, {}));
    }
    switch (operator) {
      case "+":
        values.push(left + right);
        break;
      case "-":
        values.push(left - right);
        break;
      case "*":
        values.push(left * right);
        break;
      case "/":
        if (right === 0) {
          return err(new KernelError("COMMAND_FAILED", `Division by zero in "${expression}".`, {}));
        }
        values.push(left / right);
        break;
      default:
        return err(new KernelError("COMMAND_FAILED", `Unknown operator "${operator}".`, {}));
    }
    return ok(undefined);
  };

  for (const token of tokens.value) {
    if (token.kind === "number") {
      values.push(token.value);
      continue;
    }
    if (token.kind === "name") {
      // OWN properties only. `variables` is a plain object, so it inherits from Object.prototype:
      // a rule naming `constructor`, `toString`, `valueOf`, `hasOwnProperty` or `__proto__` resolves
      // to an inherited member, which is not `undefined`, sails past the guard below and lands a
      // function on the value stack — producing a silent NaN through the whole estimate rather than
      // the named error this branch exists to raise. `typeof`/`isFinite` also cover a non-numeric or
      // NaN quantity arriving through the `Record<string, number>` type at a JSON boundary.
      const own = Object.prototype.hasOwnProperty.call(variables, token.value);
      const value = own ? variables[token.value] : undefined;
      if (!own || typeof value !== "number" || !Number.isFinite(value)) {
        // Naming a quantity the element does not carry is a rule authoring error, and silently
        // treating it as zero would produce a confident, wrong measurement.
        return err(
          new KernelError("COMMAND_FAILED", `Unknown quantity "${token.value}".`, {
            name: token.value,
            available: Object.keys(variables),
          }),
        );
      }
      values.push(value);
      continue;
    }
    if (token.value === "(") {
      operators.push(token.value);
      continue;
    }
    if (token.value === ")") {
      while (operators.length > 0 && operators[operators.length - 1] !== "(") {
        const applied = apply();
        if (!applied.ok) return err(applied.error);
      }
      if (operators.pop() !== "(") {
        return err(new KernelError("COMMAND_FAILED", `Unbalanced brackets in "${expression}".`, {}));
      }
      continue;
    }
    while (
      operators.length > 0 &&
      operators[operators.length - 1] !== "(" &&
      // Left-associative operators pop an equal-precedence predecessor so `10 - 3 - 2` groups as
      // `(10 - 3) - 2`; right-associative unary signs must not, so `- -5` nests correctly.
      ((PRECEDENCE[operators[operators.length - 1]!] ?? 0) > (PRECEDENCE[token.value] ?? 0) ||
        ((PRECEDENCE[operators[operators.length - 1]!] ?? 0) === (PRECEDENCE[token.value] ?? 0) &&
          !RIGHT_ASSOCIATIVE.has(token.value)))
    ) {
      const applied = apply();
      if (!applied.ok) return err(applied.error);
    }
    operators.push(token.value);
  }

  while (operators.length > 0) {
    if (operators[operators.length - 1] === "(") {
      return err(new KernelError("COMMAND_FAILED", `Unbalanced brackets in "${expression}".`, {}));
    }
    const applied = apply();
    if (!applied.ok) return err(applied.error);
  }

  const result = values.pop();
  if (result === undefined || values.length > 0) {
    return err(new KernelError("COMMAND_FAILED", `Malformed expression "${expression}".`, {}));
  }
  return ok(result);
}

/** Matches an element against a takeoff or classification filter. */
export function matchesFilter(
  filter: Readonly<Record<string, unknown>>,
  candidate: {
    readonly ifcClass?: string;
    readonly properties: Readonly<Record<string, unknown>>;
  },
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === "ifcClass") {
      if (candidate.ifcClass !== expected) return false;
      continue;
    }
    const actual = candidate.properties[key];
    // An array in the filter reads as "any of", which is what cost libraries express.
    if (Array.isArray(expected)) {
      if (!expected.includes(actual as never)) return false;
      continue;
    }
    if (actual !== expected) return false;
  }
  return true;
}
