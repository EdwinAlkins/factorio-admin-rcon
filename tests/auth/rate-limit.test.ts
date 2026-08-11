import { describe, expect, it } from "vitest";
import { FixedWindowLimiter } from "@/server/auth/rate-limit";

describe("FixedWindowLimiter", () => {
  it("autorise jusqu'à la limite puis refuse", () => {
    const limiter = new FixedWindowLimiter(3, 1000);

    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(true);

    const verdict = limiter.consume("a");
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.retryAfter).toBeGreaterThan(0);
  });

  it("isole les clés", () => {
    const limiter = new FixedWindowLimiter(1, 1000);

    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("b").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
  });

  it("repart à zéro après la fenêtre", () => {
    const limiter = new FixedWindowLimiter(1, 1000);
    const start = 1_000_000;

    expect(limiter.consume("a", start).allowed).toBe(true);
    expect(limiter.consume("a", start + 500).allowed).toBe(false);
    expect(limiter.consume("a", start + 1500).allowed).toBe(true);
  });

  it("purge les entrées expirées au lieu de grossir indéfiniment", () => {
    const limiter = new FixedWindowLimiter(5, 1000);
    const start = 1_000_000;

    for (let i = 0; i < 500; i++) limiter.consume(`ip-${i}`, start);
    expect(limiter.size).toBe(500);

    limiter.consume("nouvelle", start + 2000);
    expect(limiter.size).toBe(1);
  });

  it("refuse plutôt que d'accepter sans compter quand la table est pleine", () => {
    const limiter = new FixedWindowLimiter(5, 1000, 2);

    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("b").allowed).toBe(true);
    expect(limiter.consume("c").allowed).toBe(false);
  });

  it("libère une clé après un succès", () => {
    const limiter = new FixedWindowLimiter(1, 1000);

    limiter.consume("a");
    limiter.reset("a");
    expect(limiter.consume("a").allowed).toBe(true);
  });
});
