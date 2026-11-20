/**
 * Compile-time exhaustiveness. Put it in the `default` of a `switch` over a union, or at the end of an
 * `if` chain: when a member is added to the union and a branch is missing, the argument stops being
 * `never` and the build fails at that line, instead of the new case being silently ignored.
 * At run time (a value from outside the type system) it throws, naming what was not handled.
 */
export function assertNever(value: never, what = 'value'): never {
  throw new Error(`Unhandled ${what}: ${JSON.stringify(value)}`);
}
