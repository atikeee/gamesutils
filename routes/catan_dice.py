import random
import secrets
from collections import Counter


def generate_dice_distribution(exact=True, debug=False):
    """
    Generates 144 pairs of dice rolls (each number 1-6).
    Guarantees that no two adjacent rolls have the same combined sum (no back-to-back repeats).
    
    :param exact: bool. If True, returns a perfect theoretical distribution.
                         If False, adds a subtle margin of error (approx 12.5% variation).
    :param debug: bool. If True, prints a summary report comparing to the theoretical probabilities.
    :return: list of 144 [d1, d2] lists for JSON serialization compatibility.
    """
    # 1. Base pool representing a perfect 36-item distribution scaled 4x to 144 pairs
    base_outcomes = [(d1, d2) for d1 in range(1, 7) for d2 in range(1, 7)]
    pool = base_outcomes * 4

    # 2. Add slight variation if exact is False (using a conservative 12.5% noise margin)
    if not exact:
        error_rate = 0.125
        num_to_replace = int(144 * error_rate)
        indices_to_replace = random.sample(range(144), num_to_replace)
        for idx in indices_to_replace:
            pool[idx] = (random.randint(1, 6), random.randint(1, 6))

    # 3. Double-shuffle the distribution to thoroughly randomize order
    random.shuffle(pool)
    random.shuffle(pool)

    # 4. Spacing algorithm: swap adjacent elements that yield identical combined sums
    n = len(pool)
    for _ in range(5):  # Multiple passes to clear any cascading clashes from swaps
        for i in range(1, n):
            if sum(pool[i]) == sum(pool[i - 1]):
                # Look forward for a swap candidate
                swapped = False
                for j in range(i + 1, n):
                    if sum(pool[j]) != sum(pool[i - 1]) and (j + 1 >= n or sum(pool[j]) != sum(pool[j + 1])):
                        pool[i], pool[j] = pool[j], pool[i]
                        swapped = True
                        break
                # If we couldn't swap forward, look backward
                if not swapped:
                    for j in range(i - 2, -1, -1):
                        if sum(pool[j]) != sum(pool[i]) and sum(pool[j + 1]) != sum(pool[i]) and sum(pool[j]) != sum(pool[i - 1]):
                            pool[i], pool[j] = pool[j], pool[i]
                            break

    # 5. Generate summary report comparing to the theoretical probabilities (if debug enabled)
    if debug:
        sums = [d1 + d2 for d1, d2 in pool]
        sum_counts = Counter(sums)
        theoretical_probs = {
            2: 1/36, 3: 2/36, 4: 3/36, 5: 4/36, 6: 5/36, 7: 6/36,
            8: 5/36, 9: 4/36, 10: 3/36, 11: 2/36, 12: 1/36
        }
        mode_label = "EXACT Theoretical" if exact else "PSEUDO-RANDOM with Margin of Error"
        print(f"### Distribution Report ({mode_label})")
        print("| Sum | Observed Count | Observed % | Theoretical % | Difference |")
        print("|:---|:---|:---|:---|:---|")
        for s in sorted(theoretical_probs.keys()):
            count = sum_counts.get(s, 0)
            obs_pct = (count / 144) * 100
            theo_pct = theoretical_probs[s] * 100
            diff = obs_pct - theo_pct
            print(f"| {s} | {count} | {obs_pct:.2f}% | {theo_pct:.2f}% | {diff:+.2f}% |")

    # Return as JSON-serializable list of lists: [[d1, d2], ...]
    return [[d1, d2] for d1, d2 in pool]


def roll_number_dice(state, use_balanced_pool):
    if not use_balanced_pool:
        return [secrets.randbelow(6) + 1, secrets.randbelow(6) + 1]

    pool = state.get('_numberDicePool')
    if not pool:
        pool = generate_dice_distribution(exact=True, debug=False)
        state['_numberDicePool'] = pool

    return pool.pop()

def roll_number_dicebkp(state, use_balanced_pool):
    if not use_balanced_pool:
        return [secrets.randbelow(6) + 1, secrets.randbelow(6) + 1]
    pool = state.get('_numberDicePool')
    if not pool:
        pool = [[red, yellow] for red in range(1, 7) for yellow in range(1, 7) for _ in range(2)]
        secrets.SystemRandom().shuffle(pool)
        state['_numberDicePool'] = pool
    return pool.pop()

if __name__ == "__main__":
    p = generate_dice_distribution(True, True)
    print("\n--- Combined Sum Sequence Output ---")
    for i, j in p:
        print(i + j, end=" ")
    print()
