type Message = { readonly kind: "Hello" };
export const trusted = (text: string): Message => JSON.parse(text) as Message;
