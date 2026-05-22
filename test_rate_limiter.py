import math
import unittest

try:
    from rate_limiter import RateLimitRule, RateLimiter
except ModuleNotFoundError:
    RateLimitRule = None
    RateLimiter = None


class ManualClock:
    def __init__(self, now=0.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class RateLimiterTests(unittest.TestCase):
    def require_api(self):
        self.assertIsNotNone(RateLimitRule)
        self.assertIsNotNone(RateLimiter)

    def test_check_atomically_applies_multiple_token_buckets(self):
        self.require_api()
        clock = ManualClock()
        limiter = RateLimiter(
            [
                RateLimitRule("per_second", capacity=10, refill_rate_per_sec=10),
                RateLimitRule("per_minute", capacity=100, refill_rate_per_sec=100 / 60),
            ],
            shards=1,
            clock=clock,
        )

        decisions = [limiter.check("user-1") for _ in range(11)]

        self.assertTrue(all(decision.allowed for decision in decisions[:10]))
        self.assertFalse(decisions[10].allowed)
        self.assertEqual(decisions[10].failed_rules, ("per_second",))
        self.assertAlmostEqual(decisions[10].retry_after_s, 0.1)

    def test_rejected_check_does_not_charge_other_rules(self):
        self.require_api()
        clock = ManualClock()
        limiter = RateLimiter(
            [
                RateLimitRule("small", capacity=1, refill_rate_per_sec=1),
                RateLimitRule("large", capacity=2, refill_rate_per_sec=0.1),
            ],
            shards=1,
            clock=clock,
        )

        self.assertTrue(limiter.allow("user-1"))
        denied = limiter.check("user-1")
        self.assertFalse(denied.allowed)
        clock.advance(1.0)

        self.assertTrue(limiter.allow("user-1"))

    def test_cost_larger_than_capacity_never_passes(self):
        self.require_api()
        clock = ManualClock()
        limiter = RateLimiter(
            [RateLimitRule("small", capacity=1, refill_rate_per_sec=1)],
            shards=1,
            clock=clock,
        )

        decision = limiter.check("user-1", cost=2)

        self.assertFalse(decision.allowed)
        self.assertTrue(math.isinf(decision.retry_after_s))

    def test_idle_key_eviction_uses_stale_heap_entries_safely(self):
        self.require_api()
        clock = ManualClock()
        limiter = RateLimiter(
            [RateLimitRule("per_second", capacity=10, refill_rate_per_sec=10)],
            shards=1,
            clock=clock,
            eviction_budget=10,
        )

        self.assertTrue(limiter.allow("user-1"))
        clock.advance(0.5)
        self.assertTrue(limiter.allow("user-1"))
        clock.advance(0.51)
        self.assertTrue(limiter.allow("maintenance-trigger"))

        self.assertIn("user-1", limiter._shards[0].states)

        clock.advance(0.5)
        self.assertTrue(limiter.allow("another-trigger"))

        self.assertNotIn("user-1", limiter._shards[0].states)


if __name__ == "__main__":
    unittest.main()
