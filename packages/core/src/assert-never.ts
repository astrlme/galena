/** Default branch of an exhaustive `switch`: a new union member becomes a type error here. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${JSON.stringify(value)}`);
}
