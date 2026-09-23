/** Expected outcomes in core: no throwing for things a user can cause. */
export type Result<T, Code extends string> =
  | { ok: true; value: T }
  | { ok: false; error: { code: Code; message: string } };

export const ok = <T>(value: T) => ({ ok: true, value }) as const;
export const err = <Code extends string>(code: Code, message: string) =>
  ({ ok: false, error: { code, message } }) as const;
