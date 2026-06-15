# lib/ — shared worker utilities

These are Hub-shipped helpers for autoresearch worker experiments.
Import via:

    import sys
    sys.path.insert(0, "<absolute path to this dir>")
    from arena import arena_color_rotated

DO NOT reach into peer experiment dirs (`../../<other-agent>/experiments/.../code/`)
by absolute path. If you find yourself doing that, the function belongs
here — open a follow-up issue and ask the Hub to promote it into this lib.

Available helpers:
- `arena.py` — `arena_color_rotated(model_a, model_b, n_games, sims, move_fn, new_board_fn, play_game_fn)`
