export const run = (code: string): unknown => eval(code);
export const build = (body: string): unknown => new Function(body);
export const later = (): number => setTimeout("alert(1)", 10);
