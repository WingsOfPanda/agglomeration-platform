"""Shared arena helper for rehearsal workers.

Imported by worker experiments via:
    import sys
    sys.path.insert(0, "<art-dir>/lib")
    from arena import arena_color_rotated

Why this exists: multiple workers independently reimplemented color-rotated
arena in an early alpha-training session, and one implementation had a
first-move-advantage bug (arena_vs_agz_v1=0.0 masquerading as defeat)
that took hours to diagnose. A shared canonical implementation removes
that failure mode.

GAME-AGNOSTIC: this helper does NOT assume any board shape, piece
type, or move encoding. The caller passes a move_fn callback that
takes (model, board, player, sims) and returns a move; the caller
also supplies the initial board factory and the result interpreter.
"""


def arena_color_rotated(
    model_a,
    model_b,
    n_games,
    sims,
    move_fn,
    new_board_fn,
    play_game_fn,
):
    """Play n_games between model_a and model_b with color rotation.

    Each game pair: model_a as blue then model_b as red, then swap.
    Returns model_a's score in [0, 1] averaged across both colors.
    Draws count as 0.5.

    Parameters
    ----------
    model_a, model_b : opaque model handles (caller-provided)
    n_games : int (rounded down to even)
    sims : int (passed to move_fn each call)
    move_fn(model, board, player, sims) -> move
        Caller-provided move chooser.
    new_board_fn() -> board
        Caller-provided initial-position factory.
    play_game_fn(board, blue_move_fn, red_move_fn) -> {1, -1, 0}
        Caller-provided game runner that loops until terminal and
        returns +1 if blue wins, -1 if red wins, 0 if draw.

    Returns
    -------
    float : model_a's average score in [0, 1].
    """
    half = n_games // 2
    a_score = 0.0

    # Half the games: model_a plays blue, model_b plays red.
    for _ in range(half):
        board = new_board_fn()
        blue_mover = lambda b, p: move_fn(model_a, b, p, sims)
        red_mover = lambda b, p: move_fn(model_b, b, p, sims)
        result = play_game_fn(board, blue_mover, red_mover)
        if result > 0:
            a_score += 1.0
        elif result == 0:
            a_score += 0.5

    # Other half: model_a plays red, model_b plays blue.
    for _ in range(half):
        board = new_board_fn()
        blue_mover = lambda b, p: move_fn(model_b, b, p, sims)
        red_mover = lambda b, p: move_fn(model_a, b, p, sims)
        result = play_game_fn(board, blue_mover, red_mover)
        # result is from blue's perspective; flip for model_a (red).
        if result < 0:
            a_score += 1.0
        elif result == 0:
            a_score += 0.5

    total = 2 * half
    return a_score / total if total > 0 else 0.0
