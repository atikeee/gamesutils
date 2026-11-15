import secrets


def roll_number_dice(state, use_balanced_pool):
    if not use_balanced_pool:
        return [secrets.randbelow(6) + 1, secrets.randbelow(6) + 1]
    pool = state.get('_numberDicePool')
    if not pool:
        pool = [[red, yellow] for red in range(1, 7) for yellow in range(1, 7) for _ in range(2)]
        secrets.SystemRandom().shuffle(pool)
        state['_numberDicePool'] = pool
    return pool.pop()