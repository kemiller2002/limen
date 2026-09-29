type Handler = (input: string) => string;
const handlers: Readonly<Record<string, Handler>> = { a: (input) => input };

export type LooseRequest = { readonly operation: string; readonly payload: unknown };

export const route = (request: LooseRequest, name: string): string => handlers[name]!(String(request.payload));
