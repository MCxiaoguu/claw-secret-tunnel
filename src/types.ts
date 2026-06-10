export type Lifetime = "use-once" | "session" | "ttl";
export type TunnelProvider = "cloudflared" | "off";
export type SecretStatus = "pending" | "filled" | "consumed" | "expired";
export type SecretRecord = {
  id: string; key: string; token: string; label: string;
  status: SecretStatus;
  lifetime: Lifetime; createdAt: number; filledAt?: number; lastUsedAt?: number;
  linkExpiresAt: number; valueExpiresAt?: number;
};
export type SecretTunnelConfig = {
  publicUrl?: string; detectTailscale: boolean; tunnel: TunnelProvider;
  defaultLifetime: Lifetime; ttlSeconds: number; linkExpirySeconds: number; routePath: string;
};
export const DEFAULT_CONFIG: SecretTunnelConfig = {
  detectTailscale: false, tunnel: "cloudflared", defaultLifetime: "use-once",
  ttlSeconds: 300, linkExpirySeconds: 600, routePath: "/secret",
};
