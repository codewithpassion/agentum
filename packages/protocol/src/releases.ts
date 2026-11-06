/** Products served by the release routes, including the older clients. */
export const PRODUCTS = ["agentum", "hm-computer", "agentum-rs"] as const;
export type Product = (typeof PRODUCTS)[number];
