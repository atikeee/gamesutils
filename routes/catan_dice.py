from collections import Counter
import random
import secrets
import json
import os
from pathlib import Path
from threading import Lock

DICE_JSON_LOCK = Lock()
DICE_JSON_PATH = Path(__file__).resolve().parent.parent / "data" / "catan" / "dice.json"
print(DICE_JSON_PATH)
HARDCODED_36 = [
    [1, 1], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6],
    [2, 1], [2, 2], [2, 3], [2, 4], [2, 5], [2, 6],
    [3, 1], [3, 2], [3, 3], [3, 4], [3, 5], [3, 6],
    [4, 1], [4, 2], [4, 3], [4, 4], [4, 5], [4, 6],
    [5, 1], [5, 2], [5, 3], [5, 4], [5, 5], [5, 6],
    [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [6, 6],
]

def generate_dice_distribution(exact=True):
    """
    Generates 144 pairs of dice rolls (each number 1-6).
    Guarantees that no two adjacent rolls have the same combined sum (no back-to-back repeats).

    :param exact: bool. If True, returns a perfect theoretical distribution.
                         If False, adds a subtle margin of error (approx 12.5% variation).
    :return: list of 144 [d1, d2] lists for JSON serialization compatibility.
    """
    base_outcomes = [(d1, d2) for d1 in range(1, 7) for d2 in range(1, 7)]
    pool = base_outcomes * 4

    if not exact:
        error_rate = 0.125
        num_to_replace = int(144 * error_rate)
        indices_to_replace = random.sample(range(144), num_to_replace)
        for idx in indices_to_replace:
            pool[idx] = (random.randint(1, 6), random.randint(1, 6))

    random.shuffle(pool)
    random.shuffle(pool)

    n = len(pool)
    for _ in range(5):
        for i in range(1, n):
            if sum(pool[i]) == sum(pool[i - 1]):
                swapped = False
                for j in range(i + 1, n):
                    if sum(pool[j]) != sum(pool[i - 1]) and (j + 1 >= n or sum(pool[j]) != sum(pool[j + 1])):
                        pool[i], pool[j] = pool[j], pool[i]
                        swapped = True
                        break
                if not swapped:
                    for j in range(i - 2, -1, -1):
                        if sum(pool[j]) != sum(pool[i]) and sum(pool[j + 1]) != sum(pool[i]) and sum(pool[j]) != sum(pool[i - 1]):
                            pool[i], pool[j] = pool[j], pool[i]
                            break

    return [[d1, d2] for d1, d2 in pool]

def _write_dice_pool_atomic(pool):
    DICE_JSON_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = DICE_JSON_PATH.with_suffix(".json.tmp")
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(pool, f)
    os.replace(temp_path, DICE_JSON_PATH)


def generate_dice_distribution4(n=3):
    """
    Thread-safely reads a dice pair list from /data/catan/dice.json,
    generates a new shuffled sequence if empty, pops one [d1, d2] pair,
    writes the remaining list back to disk, and returns the popped pair.
    """
    with DICE_JSON_LOCK:
        pool = []
        if DICE_JSON_PATH.exists():
            try:
                with open(DICE_JSON_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, list):
                    pool = data
            except (json.JSONDecodeError, OSError):
                pool = []

        if not pool:
            pool = [pair[:] for pair in HARDCODED_36] * n
            random.shuffle(pool)
            random.shuffle(pool)

        pair = pool.pop()
        _write_dice_pool_atomic(pool)
        return pair


def _pop_soft_avoid_same_sum(pool, last_sum=None, avoid_prob=0.75):
    """
    Pops a pair from `pool`, softly avoiding back-to-back identical dice sums
    with probability `avoid_prob` while still allowing repeats for uncertainty.
    """
    if not pool:
        return None
    if last_sum is None or len(pool) == 1:
        return pool.pop()

    # Check from the end of the shuffled pool (standard pop() behavior)
    for idx in range(len(pool) - 1, -1, -1):
        candidate = pool[idx]
        candidate_sum = candidate[0] + candidate[1]
        if candidate_sum == last_sum and random.random() < avoid_prob:
            continue
        return pooldef _pop_soft_avoid_same_sum(pool, last_sum=None, avoid_prob=0.75):
    """
    Pops a pair from `pool`, softly avoiding back-to-back identical dice sums
    with probability `avoid_prob` while still allowing repeats for uncertainty.
    """
    if not pool:
        return None
    if last_sum is None or len(pool) == 1:
        return pool.pop()

    # Check from the end of the shuffled pool (standard pop() behavior)
    for idx in range(len(pool) - 1, -1, -1):
        candidate = pool[idx]
        candidate_sum = candidate[0] + candidate[1]
        if candidate_sum == last_sum and random.random() < avoid_prob:
            continue
        return pool.pop(idx)

    # Fallback if we skipped every item
    return pool.pop()


def generate_dice_distribution3(n=3, avoid_prob=0.75):
    """
    Thread-safely reads a dice pair list from /data/catan/dice.json,
    generates a new shuffled sequence if empty, softly avoids repeating
    the previous roll's sum, writes the remaining list back to disk,
    and returns [d1, d2].
    """
    with DICE_JSON_LOCK:
        pool = []
        last_sum = None

        if DICE_JSON_PATH.exists():
            try:
                with open(DICE_JSON_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                # Supports either a plain list [...] or {"pool": [...], "last_sum": int|None}
                if isinstance(data, dict):
                    if isinstance(data.get("pool"), list):
                        pool = data["pool"]
                    if isinstance(data.get("last_sum"), int):
                        last_sum = data["last_sum"]
                elif isinstance(data, list):
                    pool = data
            except (json.JSONDecodeError, OSError):
                pool = []

        if not pool:
            pool = [pair[:] for pair in HARDCODED_36] * n
            random.shuffle(pool)

        pair = _pop_soft_avoid_same_sum(pool, last_sum=last_sum, avoid_prob=avoid_prob)
        new_last_sum = pair[0] + pair[1] if pair is not None else None

        _write_dice_pool_atomic({"pool": pool, "last_sum": new_last_sum})
        return pair.pop(idx)

    # Fallback if we skipped every item
    return pool.pop()


def generate_dice_distribution3(n=3, avoid_prob=0.75):
    """
    Thread-safely reads a dice pair list from /data/catan/dice.json,
    generates a new shuffled sequence if empty, softly avoids repeating
    the previous roll's sum, writes the remaining list back to disk,
    and returns [d1, d2].
    """
    with DICE_JSON_LOCK:
        pool = []
        last_sum = None

        if DICE_JSON_PATH.exists():
            try:
                with open(DICE_JSON_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                # Supports either a plain list [...] or {"pool": [...], "last_sum": int|None}
                if isinstance(data, dict):
                    if isinstance(data.get("pool"), list):
                        pool = data["pool"]
                    if isinstance(data.get("last_sum"), int):
                        last_sum = data["last_sum"]
                elif isinstance(data, list):
                    pool = data
            except (json.JSONDecodeError, OSError):
                pool = []

        if not pool:
            pool = [pair[:] for pair in HARDCODED_36] * n
            random.shuffle(pool)

        pair = _pop_soft_avoid_same_sum(pool, last_sum=last_sum, avoid_prob=avoid_prob)
        new_last_sum = pair[0] + pair[1] if pair is not None else None

        _write_dice_pool_atomic({"pool": pool, "last_sum": new_last_sum})
        return pair



def roll_number_dice(state, alg=4):
    pool = state.get("_numberDicePool")
    if alg == 1:
        return [secrets.randbelow(6) + 1, secrets.randbelow(6) + 1]
    elif alg == 2:
        if not pool:
            pool = generate_dice_distribution(exact=True)
            state["_numberDicePool"] = pool
        return pool.pop()
    elif alg == 4:
        return generate_dice_distribution3(n=2, avoid_prob=0.75)


if __name__ == "__main__":
    def print_distribution_report(rolls, label):
        total = len(rolls)
        sums = [d1 + d2 for d1, d2 in rolls]
        sum_counts = Counter(sums)
        theoretical_probs = {
            2: 1 / 36, 3: 2 / 36, 4: 3 / 36, 5: 4 / 36, 6: 5 / 36, 7: 6 / 36,
            8: 5 / 36, 9: 4 / 36, 10: 3 / 36, 11: 2 / 36, 12: 1 / 36,
        }
        adjacent_repeats = sum(
            1 for i in range(1, total) if sums[i] == sums[i - 1]
        )

        print(f"\n### Distribution Report — {label} (Rolls={total})")
        print("| Sum | Observed Count | Observed % | Expected % | Difference |")
        print("|:---|:---|:---|:---|:---|")
        for s in sorted(theoretical_probs.keys()):
            count = sum_counts.get(s, 0)
            obs_pct = (count / total) * 100
            exp_pct = theoretical_probs[s] * 100
            diff = obs_pct - exp_pct
            print(f"| {s} | {count} | {obs_pct:.2f}% | {exp_pct:.2f}% | {diff:+.2f}% |")
        print(f"Adjacent same-sum rolls: {adjacent_repeats}")

    # Configure test parameters
    num_rolls = 20 
    algorithms = {
        1: "Alg 1 (Pure secrets)",
        2: "Alg 2 (144-pool spaced)",
        3: "Alg 3 (Hardcoded 36x3 shuffled)",
    }
    """
    for alg_id, alg_name in algorithms.items():
        state = {}
        results = [roll_number_dice(state, alg=alg_id) for _ in range(num_rolls)]
        print_distribution_report(results, alg_name)
    """
    #results = [roll_number_dice({}, alg=3) for _ in range(num_rolls)]
    results = [roll_number_dice({}, alg=4) for _ in range(1)]
    print(results)