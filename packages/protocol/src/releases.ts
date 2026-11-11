/** Products served by the release routes. */
export const PRODUCTS = ["agentum-rs"] as const;
export type Product = (typeof PRODUCTS)[number];
