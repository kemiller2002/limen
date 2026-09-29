type Secret = { readonly token: string };
export const forged = (value: string): Secret => value as unknown as Secret;
