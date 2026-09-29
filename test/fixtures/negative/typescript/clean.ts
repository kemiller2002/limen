// Legitimate browser mechanism stays expressible under every rule.
type Outcome = { readonly kind: "Success" } | { readonly kind: "Failure"; readonly reason: "denied" | "unavailable" };

const assertNever = (value: never): never => {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
};

export const describe = (outcome: Outcome): string => {
  switch (outcome.kind) {
    case "Success": return "ok";
    case "Failure": return outcome.reason;
    default: return assertNever(outcome);
  }
};

export const reflect = (element: HTMLElement, property: string, value: boolean): void => {
  Reflect.set(element, property, value);
};

export const text = (element: HTMLElement, value: string): void => {
  element.textContent = value;
};

export const parse = (json: string): unknown => JSON.parse(json) as unknown;
