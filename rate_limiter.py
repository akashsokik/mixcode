from __future__ import annotations

import heapq
import math
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Hashable, Sequence


_EPSILON = 1e-12


@dataclass(frozen=True)
class RateLimitRule:
    name: str
    capacity: float
    refill_rate_per_sec: float

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("rule name must be non-empty")
        if not math.isfinite(self.capacity) or self.capacity <= 0:
            raise ValueError("rule capacity must be a positive finite number")
        if (
            not math.isfinite(self.refill_rate_per_sec)
            or self.refill_rate_per_sec <= 0
        ):
            raise ValueError("rule refill_rate_per_sec must be a positive finite number")

    @classmethod
    def per_second(cls, name: str, limit: int) -> RateLimitRule:
        return cls(name=name, capacity=limit, refill_rate_per_sec=limit)

    @classmethod
    def per_minute(cls, name: str, limit: int) -> RateLimitRule:
        return cls(name=name, capacity=limit, refill_rate_per_sec=limit / 60)


@dataclass(frozen=True)
class RateLimitDecision:
    allowed: bool
    retry_after_s: float
    failed_rules: tuple[str, ...] = ()


@dataclass
class _Bucket:
    tokens: float
    updated_at: float


@dataclass
class _KeyState:
    buckets: list[_Bucket]
    last_seen: float
    generation: int = 0


@dataclass
class _Shard:
    lock: threading.Lock = field(default_factory=threading.Lock)
    states: dict[Hashable, _KeyState] = field(default_factory=dict)
    expirations: list[tuple[float, int, int, Hashable]] = field(default_factory=list)
    sequence: int = 0


class RateLimiter:
    def __init__(
        self,
        rules: Sequence[RateLimitRule],
        *,
        shards: int = 64,
        idle_ttl_s: float | None = None,
        eviction_budget: int = 16,
        clock: Callable[[], float] | None = None,
    ) -> None:
        if shards <= 0:
            raise ValueError("shards must be positive")
        if eviction_budget < 0:
            raise ValueError("eviction_budget must be non-negative")

        self.rules = tuple(rules)
        if not self.rules:
            raise ValueError("at least one rate limit rule is required")

        names = [rule.name for rule in self.rules]
        if len(set(names)) != len(names):
            raise ValueError("rule names must be unique")

        if idle_ttl_s is None:
            idle_ttl_s = max(
                rule.capacity / rule.refill_rate_per_sec for rule in self.rules
            )
        if not math.isfinite(idle_ttl_s) or idle_ttl_s <= 0:
            raise ValueError("idle_ttl_s must be a positive finite number")

        self._idle_ttl_s = float(idle_ttl_s)
        self._eviction_budget = int(eviction_budget)
        self._clock = clock or time.monotonic
        self._shards = [_Shard() for _ in range(shards)]

    def allow(self, key: Hashable, cost: float = 1) -> bool:
        return self.check(key, cost).allowed

    def check(self, key: Hashable, cost: float = 1) -> RateLimitDecision:
        if not math.isfinite(cost) or cost <= 0:
            raise ValueError("cost must be a positive finite number")

        now = float(self._clock())
        shard = self._shard_for(key)

        with shard.lock:
            self._evict_expired(shard, now)

            state = shard.states.get(key)
            if state is None:
                state = self._new_state(now)
                shard.states[key] = state
                self._push_expiry(shard, key, state, now + self._idle_ttl_s)

            for rule, bucket in zip(self.rules, state.buckets):
                self._refill(rule, bucket, now)

            failed_rules: list[str] = []
            retry_after_s = 0.0

            for rule, bucket in zip(self.rules, state.buckets):
                if cost > rule.capacity:
                    failed_rules.append(rule.name)
                    retry_after_s = math.inf
                elif bucket.tokens + _EPSILON < cost:
                    failed_rules.append(rule.name)
                    shortfall = cost - bucket.tokens
                    retry_after_s = max(
                        retry_after_s, shortfall / rule.refill_rate_per_sec
                    )

            allowed = not failed_rules
            if allowed:
                for bucket in state.buckets:
                    bucket.tokens = max(0.0, bucket.tokens - cost)
                retry_after_s = 0.0

            state.last_seen = now
            state.generation += 1

            return RateLimitDecision(
                allowed=allowed,
                retry_after_s=retry_after_s,
                failed_rules=tuple(failed_rules),
            )

    def _shard_for(self, key: Hashable) -> _Shard:
        return self._shards[hash(key) % len(self._shards)]

    def _new_state(self, now: float) -> _KeyState:
        return _KeyState(
            buckets=[
                _Bucket(tokens=rule.capacity, updated_at=now) for rule in self.rules
            ],
            last_seen=now,
        )

    def _refill(self, rule: RateLimitRule, bucket: _Bucket, now: float) -> None:
        elapsed = now - bucket.updated_at
        if elapsed <= 0:
            return

        bucket.tokens = min(
            rule.capacity,
            bucket.tokens + elapsed * rule.refill_rate_per_sec,
        )
        bucket.updated_at = now

    def _push_expiry(
        self, shard: _Shard, key: Hashable, state: _KeyState, expires_at: float
    ) -> None:
        shard.sequence += 1
        heapq.heappush(
            shard.expirations,
            (expires_at, shard.sequence, state.generation, key),
        )

    def _evict_expired(self, shard: _Shard, now: float) -> None:
        for _ in range(self._eviction_budget):
            if not shard.expirations or shard.expirations[0][0] > now:
                return

            _expires_at, _sequence, generation, key = heapq.heappop(shard.expirations)
            state = shard.states.get(key)
            if state is None:
                continue

            current_expires_at = state.last_seen + self._idle_ttl_s
            if current_expires_at <= now:
                del shard.states[key]
                continue

            if generation != state.generation:
                self._push_expiry(shard, key, state, current_expires_at)
