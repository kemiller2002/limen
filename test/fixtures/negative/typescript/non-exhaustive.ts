type Outcome = { readonly kind: "Success" } | { readonly kind: "Failure" } | { readonly kind: "OutcomeUnknown" };

export const describe = (outcome: Outcome): string => {
  switch (outcome.kind) {
    case "Success": return "ok";
    case "Failure": return "failed";
  }
  return "?";
};

export const swallow = (outcome: Outcome): string => {
  switch (outcome.kind) {
    case "Success": return "ok";
    default: return "treated as failure";
  }
};
