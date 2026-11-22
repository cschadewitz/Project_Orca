- **plan:** the critical path no longer counts overlapping work in full. Along a
  later-phase dependency (`other#build`) the first half of the dependent overlaps the
  upstream item, an item already underway counts half its estimate, and a stage-level
  dependency whose stage was already produced costs nothing more of the upstream (#108).
