# Deterministic variation

Normalize names and expand functions before generating draws. A function call contributes
its normalized use position to the address; transparent name/group wrappers contribute none.

For `vary(k)`, select `ceil(min(k,9) * attacks / 10)` attacks by ranking their first draw
(ties by attack index). A second draw chooses direction and a third chooses one or two scale
steps. Notes receive that scale shift; hits move one input-grid cell in the chosen direction,
wrapping at the extent. `vary(pitch)` uses the note rule with k=1. `vary(rhythm)` uses the grid
rule with k=1, preserving the written pitch sequence. Shared attack cells retain identities.

The input grid is the smallest written attack span. Type and extent remain unchanged.
Addresses contain the nearest enclosing seed, purpose `vary`, normalized use/copy position,
canonical material description, attack index and operation ordinal from the root literal.
SHA-256, SplitMix64 and xoshiro256** supply the draws (docs/reference/LANGUAGE.md §15.2).
